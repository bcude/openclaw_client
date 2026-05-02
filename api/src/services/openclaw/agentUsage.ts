import {
  AgentUsageDailyPoint,
  AgentUsageLatency,
  AgentUsageMessageCounts,
  AgentUsageModelRow,
  AgentUsageResponse,
  AgentUsageSessionRow,
  AgentUsageToolRow,
  AgentUsageTotals,
} from '../../@types/openclaw';
import { getAgentRawUsageFromDisk } from './localUsage';

interface RawDailyBreakdown {
  date?: string;
  tokens?: number;
  cost?: number;
}

interface RawDailyMessageCount {
  date?: string;
  total?: number;
  user?: number;
  assistant?: number;
  toolCalls?: number;
  toolResults?: number;
  errors?: number;
}

interface RawDailyLatency {
  date?: string;
  count?: number;
  avgMs?: number;
  p95Ms?: number;
}

interface RawModelUsageTotals {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalCost?: number;
}

interface RawModelUsageRow {
  provider?: string;
  model?: string;
  count?: number;
  totals?: RawModelUsageTotals;
}

interface RawToolUsage {
  totalCalls?: number;
  uniqueTools?: number;
  tools?: { name?: string; count?: number }[];
}

interface RawSessionUsage {
  firstActivity?: number;
  lastActivity?: number;
  dailyBreakdown?: RawDailyBreakdown[];
  dailyMessageCounts?: RawDailyMessageCount[];
  dailyLatency?: RawDailyLatency[];
  messageCounts?: RawDailyMessageCount;
  toolUsage?: RawToolUsage;
  modelUsage?: RawModelUsageRow[];
  latency?: RawDailyLatency;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalCost?: number;
}

interface RawUsageSession {
  key?: string;
  label?: string | null;
  channel?: string | null;
  agentId?: string;
  modelProvider?: string | null;
  model?: string | null;
  updatedAt?: number | null;
  usage?: RawSessionUsage;
}

export interface RawUsagePayload {
  startDate?: string | null;
  endDate?: string | null;
  sessions?: RawUsageSession[];
}

export type { RawUsageSession, RawSessionUsage, RawDailyBreakdown };

function emptyResponse(openclawAgentId: string, known: boolean): AgentUsageResponse {
  return {
    agentId: openclawAgentId,
    known,
    range: { startDate: null, endDate: null },
    sessionCount: 0,
    firstActivity: null,
    lastActivity: null,
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
    },
    messageCounts: { total: 0, user: 0, assistant: 0, toolCalls: 0, errors: 0 },
    latency: { count: 0, avgMs: 0, p95Ms: 0 },
    daily: [],
    models: [],
    tools: [],
    sessions: [],
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function aggregateDaily(rows: RawDailyBreakdown[][]): AgentUsageDailyPoint[] {
  const map = new Map<string, AgentUsageDailyPoint>();
  rows.flat().forEach((r) => {
    if (!r?.date) return;
    const prev = map.get(r.date) ?? { date: r.date, tokens: 0, cost: 0 };
    prev.tokens += num(r.tokens);
    prev.cost += num(r.cost);
    map.set(r.date, prev);
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function aggregateModels(rows: RawModelUsageRow[][]): AgentUsageModelRow[] {
  const map = new Map<string, AgentUsageModelRow>();
  rows.flat().forEach((r) => {
    const provider = r?.provider || '';
    const model = r?.model || '';
    if (!provider && !model) return;
    const key = `${provider}/${model}`;
    const prev =
      map.get(key) ??
      ({
        provider,
        model,
        count: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
      } as AgentUsageModelRow);
    prev.count += num(r.count);
    prev.input += num(r.totals?.input);
    prev.output += num(r.totals?.output);
    prev.cacheRead += num(r.totals?.cacheRead);
    prev.cacheWrite += num(r.totals?.cacheWrite);
    prev.totalTokens += num(r.totals?.totalTokens);
    prev.totalCost += num(r.totals?.totalCost);
    map.set(key, prev);
  });
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function aggregateTools(rows: RawToolUsage[]): AgentUsageToolRow[] {
  const map = new Map<string, number>();
  rows.forEach((tu) => {
    (tu?.tools ?? []).forEach((t) => {
      if (!t?.name) return;
      map.set(t.name, (map.get(t.name) ?? 0) + num(t.count));
    });
  });
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function aggregateMessageCounts(rows: RawDailyMessageCount[]): AgentUsageMessageCounts {
  return rows.reduce<AgentUsageMessageCounts>(
    (acc, r) => ({
      total: acc.total + num(r?.total),
      user: acc.user + num(r?.user),
      assistant: acc.assistant + num(r?.assistant),
      toolCalls: acc.toolCalls + num(r?.toolCalls),
      errors: acc.errors + num(r?.errors),
    }),
    { total: 0, user: 0, assistant: 0, toolCalls: 0, errors: 0 }
  );
}

interface LatencyAcc {
  count: number;
  avgWeighted: number;
  p95Max: number;
}

function aggregateLatency(rows: RawDailyLatency[]): AgentUsageLatency {
  const total = rows.reduce<LatencyAcc>(
    (acc, r) => {
      const c = num(r?.count);
      acc.count += c;
      acc.avgWeighted += c * num(r?.avgMs);
      acc.p95Max = Math.max(acc.p95Max, num(r?.p95Ms));
      return acc;
    },
    { count: 0, avgWeighted: 0, p95Max: 0 }
  );
  return {
    count: total.count,
    avgMs: total.count > 0 ? total.avgWeighted / total.count : 0,
    p95Ms: total.p95Max,
  };
}

export async function getAgentUsage(openclawAgentId: string): Promise<AgentUsageResponse> {
  const payload = await getAgentRawUsageFromDisk(openclawAgentId);
  if (!payload || !Array.isArray(payload.sessions)) {
    return emptyResponse(openclawAgentId, false);
  }

  const sessions = payload.sessions.filter((s) => s?.agentId === openclawAgentId);
  if (sessions.length === 0) {
    const empty = emptyResponse(openclawAgentId, true);
    empty.range = {
      startDate: payload.startDate ?? null,
      endDate: payload.endDate ?? null,
    };
    return empty;
  }

  const totals: AgentUsageTotals = sessions.reduce<AgentUsageTotals>(
    (acc, s) => {
      const u = s.usage ?? {};
      acc.input += num(u.input);
      acc.output += num(u.output);
      acc.cacheRead += num(u.cacheRead);
      acc.cacheWrite += num(u.cacheWrite);
      acc.totalTokens += num(u.totalTokens);
      acc.totalCost += num(u.totalCost);
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 }
  );

  const firstActivity = sessions
    .map((s) => num(s.usage?.firstActivity))
    .filter((n) => n > 0)
    .reduce((acc, n) => (acc === 0 ? n : Math.min(acc, n)), 0);
  const lastActivity = sessions
    .map((s) => num(s.usage?.lastActivity))
    .reduce((acc, n) => Math.max(acc, n), 0);

  const daily = aggregateDaily(sessions.map((s) => s.usage?.dailyBreakdown ?? []));
  const models = aggregateModels(sessions.map((s) => s.usage?.modelUsage ?? []));
  const tools = aggregateTools(sessions.map((s) => s.usage?.toolUsage ?? {}));
  const messageCounts = aggregateMessageCounts(
    sessions.map((s) => s.usage?.messageCounts ?? {}).filter((x): x is RawDailyMessageCount => !!x)
  );
  const latency = aggregateLatency(
    sessions.map((s) => s.usage?.latency ?? {}).filter((x): x is RawDailyLatency => !!x)
  );

  const sessionRows: AgentUsageSessionRow[] = sessions
    .map((s) => ({
      key: s.key ?? '',
      label: s.label ?? null,
      channel: s.channel ?? null,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
      totalTokens: num(s.usage?.totalTokens),
      totalCost: num(s.usage?.totalCost),
      modelProvider: s.modelProvider ?? null,
      model: s.model ?? null,
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return {
    agentId: openclawAgentId,
    known: true,
    range: {
      startDate: payload.startDate ?? null,
      endDate: payload.endDate ?? null,
    },
    sessionCount: sessions.length,
    firstActivity: firstActivity || null,
    lastActivity: lastActivity || null,
    totals,
    messageCounts,
    latency,
    daily,
    models,
    tools,
    sessions: sessionRows,
  };
}
