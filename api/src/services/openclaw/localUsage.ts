/* eslint-disable no-console */
/**
 * Disk-based replacement for the `sessions.usage` gateway RPC.
 *
 * Each session writes a message JSONL at
 * `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. Every assistant
 * entry already carries the **authoritative** usage block OpenClaw uses for
 * billing (including pre-computed `cost` fields) so we don't need a local
 * price table.
 *
 * IMPORTANT: this module uses **async** file I/O exclusively. Synchronous
 * reads would block Node's event loop for tens of ms while the largest agents
 * are parsed cold, freezing every other in-flight HTTP request. With async
 * I/O the event loop yields at every `await` boundary, so the spend rings
 * (which fan out across all agents) load concurrently and don't gum up the
 * rest of the server.
 *
 * BAK MERGING: OpenClaw rotates a session's history by renaming the live
 * `<id>.jsonl` to `<id>.jsonl.bak-<pid>-<ts>` and starting fresh whenever it
 * detects a stuck session or simply runs out of context. In the common case
 * the bak is a strict prefix of the live file, but during a stuck-session
 * recovery the bak can carry entries the live no longer has. We parse every
 * `.bak-*` alongside the live file and **deduplicate by `entry.id`** so we
 * neither double-count the common rotation nor lose history when a recovery
 * truncates the live file.
 *
 * Caching is layered:
 *   - per-file fact lists are memoised on `(path, mtime, size)`
 *   - per-session aggregates are memoised on the fingerprint of all related
 *     files (live + every bak), so adding/removing a bak invalidates correctly
 */
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import { agentDir } from './paths';
import type { RawSessionUsage, RawUsageSession, RawUsagePayload } from './agentUsage';

interface JsonlUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface JsonlUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: JsonlUsageCost;
}

interface JsonlContentPart {
  type?: string;
  /** `toolCall` parts carry the tool name we count for the tools breakdown. */
  name?: string;
}

interface JsonlMessage {
  role?: string;
  provider?: string;
  model?: string;
  usage?: JsonlUsage;
  timestamp?: number;
  content?: JsonlContentPart[] | string;
  errorMessage?: string;
}

interface JsonlEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: JsonlMessage;
}

/** Compact per-entry record extracted from one JSONL line.
 *
 * Storing facts (rather than a running sum) lets us merge multiple files
 * for the same session and dedupe by `id` before aggregating. The shape is
 * intentionally narrow — only what the aggregator needs. */
interface EntryFact {
  /** Stable per-message id from OpenClaw. Used as the dedup key when merging
   *  the live file with its `.bak-*` siblings. May be absent on legacy meta
   *  entries; those are kept (not deduped) to preserve their timestamps. */
  id?: string;
  ts: number | null;
  role?: string;
  errored: boolean;
  /** Tool names harvested from assistant `toolCall` content parts. */
  toolNames: string[];
  /** Set only for assistant turns that carry a `usage` block. */
  usage?: {
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
}

/** Per-session aggregate built by merging fact lists from one or more files. */
interface SessionAggregate {
  sessionId: string;
  agentId: string;
  channel: string | null;
  provider: string | null;
  model: string | null;
  firstTs: number | null;
  lastTs: number | null;
  /** Number of assistant turns observed (i.e. entries that carry `usage`). */
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  daily: Map<string, { tokens: number; cost: number }>;
  modelByKey: Map<
    string,
    {
      provider: string;
      model: string;
      count: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      totalCost: number;
    }
  >;
  /** Per-role message tallies for the dashboard's "Messages" stat card. */
  messages: { total: number; user: number; assistant: number; toolCalls: number; errors: number };
  /** Tool name → invocation count, harvested from assistant `toolCall` parts. */
  toolByName: Map<string, number>;
  /** Latency samples in ms — one per assistant turn, computed as the gap
   *  between the assistant entry and the previous non-assistant entry. */
  latencySamples: number[];
}

interface FileFactsCache {
  mtimeMs: number;
  size: number;
  facts: EntryFact[];
}

/** Per-file fact-list cache, keyed by absolute path. */
const fileCache = new Map<string, FileFactsCache>();

/** In-flight parse de-dup, keyed by absolute path. */
const fileInflight = new Map<string, Promise<EntryFact[] | null>>();

interface SessionAggCache {
  /** Fingerprint of every file that fed this aggregate. Invalidates when any
   *  file's mtime/size changes or a new bak is added/removed. */
  fingerprint: string;
  data: SessionAggregate;
}

const sessionCache = new Map<string, SessionAggCache>();

function isoDay(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function parseTimestamp(ts: string | number | undefined): number | null {
  if (ts === undefined || ts === null) return null;
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

interface SessionsJsonValue {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  label?: string | null;
}

async function readSessionsJson(
  openclawAgentId: string
): Promise<Record<string, SessionsJsonValue> | null> {
  const file = path.join(agentDir(openclawAgentId), 'sessions', 'sessions.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as Record<string, SessionsJsonValue>;
  } catch {
    return null;
  }
}

/**
 * Parse one JSONL file (live OR `.bak-*`) into a fact list. Append-only
 * during a session and immutable once rotated, so we memoise on
 * `(path, mtime, size)`. Reads stream line-by-line so multi-MB files yield
 * to the event loop and don't freeze concurrent requests.
 */
async function parseFileFacts(filePath: string): Promise<EntryFact[] | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.facts;
  }

  const pending = fileInflight.get(filePath);
  if (pending) return pending;

  const parsePromise = (async (): Promise<EntryFact[] | null> => {
    const facts: EntryFact[] = [];

    const ingestLine = (line: string): void => {
      if (!line || line.length < 2) return;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line) as JsonlEntry;
      } catch {
        return;
      }

      const ts = parseTimestamp(entry.timestamp ?? entry.message?.timestamp);
      const msg = entry.message;
      if (!msg) return;

      const fact: EntryFact = {
        id: entry.id,
        ts,
        role: msg.role,
        errored: Boolean(msg.errorMessage),
        toolNames: [],
      };

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach((part) => {
          if (part?.type === 'toolCall' && part.name) fact.toolNames.push(part.name);
        });
      }

      if (msg.role === 'assistant' && msg.usage) {
        const inputTok = num(msg.usage.input);
        const outputTok = num(msg.usage.output);
        const cacheReadTok = num(msg.usage.cacheRead);
        const cacheWriteTok = num(msg.usage.cacheWrite);
        const totalTok =
          num(msg.usage.totalTokens) || inputTok + outputTok + cacheReadTok + cacheWriteTok;
        fact.usage = {
          provider: msg.provider ?? '',
          model: msg.model ?? '',
          input: inputTok,
          output: outputTok,
          cacheRead: cacheReadTok,
          cacheWrite: cacheWriteTok,
          totalTokens: totalTok,
          cost: num(msg.usage.cost?.total),
        };
      }

      facts.push(fact);
    };

    const ok = await new Promise<boolean>((resolve) => {
      const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      stream.once('error', () => resolve(false));
      rl.on('line', ingestLine);
      rl.once('close', () => resolve(true));
    });
    if (!ok) return null;

    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
    return facts;
  })();

  fileInflight.set(filePath, parsePromise);
  try {
    return await parsePromise;
  } finally {
    fileInflight.delete(filePath);
  }
}

/**
 * Merge facts from every file belonging to a session, deduplicate by
 * `entry.id`, and aggregate into a `SessionAggregate`.
 *
 * Live file is preferred when an id collides with a bak — in practice the
 * shape is identical, but the live copy is by definition the canonical one.
 * Entries without an `id` (rare meta lines) are passed through; they don't
 * collide so dedup is moot.
 */
function aggregateSession(
  sessionId: string,
  agentId: string,
  files: { filePath: string; isLive: boolean; facts: EntryFact[] }[]
): SessionAggregate {
  const agg: SessionAggregate = {
    sessionId,
    agentId,
    channel: null,
    provider: null,
    model: null,
    firstTs: null,
    lastTs: null,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    daily: new Map(),
    modelByKey: new Map(),
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, errors: 0 },
    toolByName: new Map(),
    latencySamples: [],
  };

  /* Process live first so live entries claim ids before any bak does. */
  const ordered = [...files].sort((a, b) => Number(b.isLive) - Number(a.isLive));
  const seen = new Set<string>();
  const merged: EntryFact[] = [];
  ordered.forEach(({ facts }) => {
    facts.forEach((f) => {
      if (f.id) {
        if (seen.has(f.id)) return;
        seen.add(f.id);
      }
      merged.push(f);
    });
  });

  /* Sort by timestamp so latency calc walks the conversation chronologically
   * even when bak entries pre-date some live entries. Entries without a ts
   * sink to the end where they don't disturb latency pairing. */
  merged.sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return a.ts - b.ts;
  });

  let priorNonAssistantTs: number | null = null;

  merged.forEach((f) => {
    if (f.ts !== null) {
      if (agg.firstTs === null || f.ts < agg.firstTs) agg.firstTs = f.ts;
      if (agg.lastTs === null || f.ts > agg.lastTs) agg.lastTs = f.ts;
    }

    if (f.role === 'user') {
      agg.messages.total += 1;
      agg.messages.user += 1;
      if (f.ts !== null) priorNonAssistantTs = f.ts;
    } else if (f.role === 'toolResult') {
      agg.messages.total += 1;
      if (f.ts !== null) priorNonAssistantTs = f.ts;
    } else if (f.role === 'assistant') {
      agg.messages.total += 1;
      agg.messages.assistant += 1;
      if (f.errored) agg.messages.errors += 1;

      f.toolNames.forEach((name) => {
        agg.messages.toolCalls += 1;
        agg.toolByName.set(name, (agg.toolByName.get(name) ?? 0) + 1);
      });

      if (f.ts !== null && priorNonAssistantTs !== null) {
        const delta = f.ts - priorNonAssistantTs;
        if (delta >= 0 && delta < 10 * 60 * 1000) {
          agg.latencySamples.push(delta);
        }
        priorNonAssistantTs = null;
      }
    }

    if (!f.usage) return;

    if (!agg.provider && f.usage.provider) agg.provider = f.usage.provider;
    if (!agg.model && f.usage.model) agg.model = f.usage.model;

    agg.turns += 1;
    agg.input += f.usage.input;
    agg.output += f.usage.output;
    agg.cacheRead += f.usage.cacheRead;
    agg.cacheWrite += f.usage.cacheWrite;
    agg.totalTokens += f.usage.totalTokens;
    agg.totalCost += f.usage.cost;

    if (f.ts !== null) {
      const day = isoDay(f.ts);
      const dayAcc = agg.daily.get(day) ?? { tokens: 0, cost: 0 };
      dayAcc.tokens += f.usage.totalTokens;
      dayAcc.cost += f.usage.cost;
      agg.daily.set(day, dayAcc);
    }

    const mkey = `${f.usage.provider}/${f.usage.model}`;
    const m =
      agg.modelByKey.get(mkey) ??
      {
        provider: f.usage.provider,
        model: f.usage.model,
        count: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
      };
    m.count += 1;
    m.input += f.usage.input;
    m.output += f.usage.output;
    m.cacheRead += f.usage.cacheRead;
    m.cacheWrite += f.usage.cacheWrite;
    m.totalTokens += f.usage.totalTokens;
    m.totalCost += f.usage.cost;
    agg.modelByKey.set(mkey, m);
  });

  return agg;
}

/** Discover & group every JSONL related to one session: the live `<id>.jsonl`
 *  plus every `<id>.jsonl.bak-*` sibling. The session id is the basename
 *  before the first `.jsonl`. */
interface SessionGroup {
  sessionId: string;
  sessionKey: string;
  label: string | null;
  updatedAt: number | null;
  liveFile: string | null;
  bakFiles: string[];
}

async function listSessionGroups(openclawAgentId: string): Promise<SessionGroup[]> {
  const dir = path.join(agentDir(openclawAgentId), 'sessions');

  let dirEntries;
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  /* Bucket every file by sessionId. We accept three forms:
   *   - <id>.jsonl                (live)
   *   - <id>.jsonl.bak-<pid>-<ts> (rotation snapshot)
   * trajectory + deleted files are ignored. */
  const buckets = new Map<string, { liveFile: string | null; bakFiles: string[] }>();
  dirEntries.forEach((e) => {
    if (!e.isFile()) return;
    const { name } = e;
    if (name.endsWith('.trajectory.jsonl')) return;
    const fullPath = path.join(dir, name);

    const bakIdx = name.indexOf('.jsonl.bak-');
    if (bakIdx > 0) {
      const sessionId = name.slice(0, bakIdx);
      const b = buckets.get(sessionId) ?? { liveFile: null, bakFiles: [] };
      b.bakFiles.push(fullPath);
      buckets.set(sessionId, b);
      return;
    }

    if (name.endsWith('.jsonl')) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      const b = buckets.get(sessionId) ?? { liveFile: null, bakFiles: [] };
      b.liveFile = fullPath;
      buckets.set(sessionId, b);
    }
  });

  /* Marry bucket data with sessions.json metadata (label, updatedAt, key). */
  const sessions = await readSessionsJson(openclawAgentId);
  const metaByFile = new Map<string, { sessionKey: string; updatedAt: number | null; label: string | null }>();
  if (sessions) {
    const prefix = `agent:${openclawAgentId}:`;
    Object.entries(sessions).forEach(([key, val]) => {
      if (!key.startsWith(prefix)) return;
      const filePath = val?.sessionFile ?? path.join(dir, `${val?.sessionId ?? ''}.jsonl`);
      if (!filePath) return;
      metaByFile.set(filePath, {
        sessionKey: key.slice(prefix.length),
        updatedAt: typeof val?.updatedAt === 'number' ? val.updatedAt : null,
        label: val?.label ?? null,
      });
    });
  }

  const groups: SessionGroup[] = [];
  buckets.forEach((b, sessionId) => {
    const meta = b.liveFile ? metaByFile.get(b.liveFile) : undefined;
    groups.push({
      sessionId,
      sessionKey: meta?.sessionKey ?? sessionId,
      label: meta?.label ?? null,
      updatedAt: meta?.updatedAt ?? null,
      liveFile: b.liveFile,
      bakFiles: b.bakFiles,
    });
  });

  return groups;
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function avg(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function toRawSession(
  agg: SessionAggregate,
  meta: { sessionKey: string; updatedAt: number | null; label: string | null }
): RawUsageSession {
  const usage: RawSessionUsage = {
    firstActivity: agg.firstTs ?? undefined,
    lastActivity: agg.lastTs ?? undefined,
    dailyBreakdown: [...agg.daily.entries()]
      .map(([date, v]) => ({ date, tokens: v.tokens, cost: v.cost }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    modelUsage: [...agg.modelByKey.values()].map((m) => ({
      provider: m.provider,
      model: m.model,
      count: m.count,
      totals: {
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        totalTokens: m.totalTokens,
        totalCost: m.totalCost,
      },
    })),
    input: agg.input,
    output: agg.output,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
    totalTokens: agg.totalTokens,
    totalCost: agg.totalCost,
    messageCounts: {
      total: agg.messages.total,
      user: agg.messages.user,
      assistant: agg.messages.assistant,
      toolCalls: agg.messages.toolCalls,
      errors: agg.messages.errors,
    },
    toolUsage: {
      totalCalls: agg.messages.toolCalls,
      uniqueTools: agg.toolByName.size,
      tools: [...agg.toolByName.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    },
    latency: {
      count: agg.latencySamples.length,
      avgMs: avg(agg.latencySamples),
      p95Ms: p95(agg.latencySamples),
    },
  };

  return {
    key: `agent:${agg.agentId}:${meta.sessionKey}`,
    label: meta.label,
    channel: agg.channel,
    agentId: agg.agentId,
    modelProvider: agg.provider,
    model: agg.model,
    updatedAt: meta.updatedAt ?? agg.lastTs,
    usage,
  };
}

/**
 * Resolve & aggregate one session: parse live + every bak in parallel, then
 * dedupe-by-id and aggregate. Cached on the fingerprint of every contributing
 * file so warm hits are O(map lookup).
 */
async function resolveSessionAggregate(
  group: SessionGroup,
  openclawAgentId: string
): Promise<SessionAggregate | null> {
  const allPaths = [
    ...(group.liveFile ? [{ filePath: group.liveFile, isLive: true }] : []),
    ...group.bakFiles.map((p) => ({ filePath: p, isLive: false })),
  ];
  if (allPaths.length === 0) return null;

  /* Fingerprint = stat of every related file, sorted for stability. */
  const stats = await Promise.all(
    allPaths.map(async (f) => {
      try {
        const s = await fs.stat(f.filePath);
        return { ...f, mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    })
  );
  const liveFiles = stats.filter((s): s is NonNullable<typeof s> => s !== null);
  if (liveFiles.length === 0) return null;

  const fingerprint = [...liveFiles]
    .map((s) => `${s.filePath}:${s.mtimeMs}:${s.size}`)
    .sort()
    .join('|');

  const cached = sessionCache.get(group.sessionId);
  if (cached && cached.fingerprint === fingerprint) return cached.data;

  const parsed = await Promise.all(
    liveFiles.map(async (f) => {
      const facts = await parseFileFacts(f.filePath);
      return facts ? { filePath: f.filePath, isLive: f.isLive, facts } : null;
    })
  );
  const usable = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  if (usable.length === 0) return null;

  const agg = aggregateSession(group.sessionId, openclawAgentId, usable);
  sessionCache.set(group.sessionId, { fingerprint, data: agg });
  return agg;
}

/**
 * Build a `RawUsagePayload` for one agent by walking that agent's session
 * groups (live JSONL + every bak rotation). Returns `null` when the agent
 * has no sessions yet.
 *
 * Files are parsed in parallel; each parse uses async I/O and yields to the
 * event loop while reading large files, so concurrent requests don't queue.
 */
export async function getAgentRawUsageFromDisk(
  openclawAgentId: string
): Promise<RawUsagePayload | null> {
  const groups = await listSessionGroups(openclawAgentId);
  if (groups.length === 0) return null;

  const sessions = (
    await Promise.all(
      groups.map(async (g) => {
        const agg = await resolveSessionAggregate(g, openclawAgentId);
        if (!agg) return null;
        return toRawSession(agg, {
          sessionKey: g.sessionKey,
          updatedAt: g.updatedAt,
          label: g.label,
        });
      })
    )
  ).filter((s): s is RawUsageSession => s !== null);

  const firstSeen = sessions.reduce<number>((min, s) => {
    const v = s.usage?.firstActivity;
    return typeof v === 'number' && v < min ? v : min;
  }, Number.POSITIVE_INFINITY);
  const lastSeen = sessions.reduce<number>((max, s) => {
    const v = s.usage?.lastActivity;
    return typeof v === 'number' && v > max ? v : max;
  }, 0);

  return {
    startDate: Number.isFinite(firstSeen) ? new Date(firstSeen).toISOString() : null,
    endDate: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
    sessions,
  };
}

/** Drop the in-memory parse caches — used after writes that may invalidate them. */
export function invalidateLocalUsageCache(): void {
  fileCache.clear();
  sessionCache.clear();
}
