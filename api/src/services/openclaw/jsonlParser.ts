import fs from 'fs';
import {
  JsonlContentPart,
  JsonlEntry,
  JsonlTextPart,
  JsonlThinkingPart,
  JsonlToolCallPart,
  OpenClawMessage,
  ToolStep,
  ToolStepOutput,
} from '../../@types/openclaw';

/** Hard limits to keep tool step JSON small enough to live alongside chat
 *  messages in SQLite without blowing up message payloads. Real tool I/O
 *  (e.g. file dumps, large model outputs) routinely runs past these caps;
 *  the UI shows a "(truncated)" hint when that happens. */
const MAX_TOOL_INPUT_VALUE_CHARS = 8_000;
const MAX_TOOL_OUTPUT_TEXT_CHARS = 16_000;
/** Provider-specific noise we never want to surface to the UI. */
const HIDDEN_TOOL_INPUT_KEYS = new Set(['thoughtSignature']);

function isTextPart(p: JsonlContentPart): p is JsonlTextPart {
  return p.type === 'text' && typeof (p as JsonlTextPart).text === 'string';
}

function isThinkingPart(p: JsonlContentPart): p is JsonlThinkingPart {
  return p.type === 'thinking' && typeof (p as JsonlThinkingPart).thinking === 'string';
}

function truncateString(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`, truncated: true };
}

function sanitizeToolInput(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const out: Record<string, unknown> = {};
  Object.entries(args as Record<string, unknown>).forEach(([k, v]) => {
    if (HIDDEN_TOOL_INPUT_KEYS.has(k)) return;
    if (typeof v === 'string') {
      out[k] = truncateString(v, MAX_TOOL_INPUT_VALUE_CHARS).value;
    } else {
      /* For nested objects we serialize once + truncate, avoiding deep
       * recursion through arbitrary tool schemas. */
      try {
        const json = JSON.stringify(v);
        if (json && json.length > MAX_TOOL_INPUT_VALUE_CHARS) {
          out[k] = `${json.slice(0, MAX_TOOL_INPUT_VALUE_CHARS)}…[truncated]`;
        } else {
          out[k] = v;
        }
      } catch {
        out[k] = '[unserialisable]';
      }
    }
  });
  return Object.keys(out).length === 0 ? null : out;
}

function isToolCallPart(p: JsonlContentPart): p is JsonlToolCallPart {
  return (
    Boolean(p) && typeof p === 'object' && (p as { type?: unknown }).type === 'toolCall'
  );
}

/**
 * Walk all JSONL entries once and index `toolResult` rows by their
 * `toolCallId`. The map gives us O(1) lookup when assembling assistant
 * messages so the parser stays O(N) overall.
 */
function indexToolResults(entries: JsonlEntry[]): Map<string, ToolStepOutput> {
  const out = new Map<string, ToolStepOutput>();
  entries.forEach((entry) => {
    if (entry.type !== 'message') return;
    const msg = entry.message as
      | {
          role?: string;
          toolCallId?: string;
          content?: JsonlContentPart[] | string;
          isError?: boolean;
          details?: Record<string, unknown>;
        }
      | undefined;
    if (!msg || msg.role !== 'toolResult' || !msg.toolCallId) return;

    /* The result's primary text lives either as a single string in
     * `content` or as a list of text parts. Joining is the safe default. */
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(isTextPart)
        .map((c) => c.text)
        .join('\n');
    }
    const { value: clipped, truncated } = truncateString(text, MAX_TOOL_OUTPUT_TEXT_CHARS);

    const details = (msg.details ?? {}) as {
      status?: unknown;
      exitCode?: unknown;
      durationMs?: unknown;
    };
    out.set(msg.toolCallId, {
      text: clipped,
      isError: msg.isError === true,
      status: typeof details.status === 'string' ? details.status : null,
      exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
      durationMs: typeof details.durationMs === 'number' ? details.durationMs : null,
      truncated,
    });
  });
  return out;
}

function extractToolSteps(
  content: JsonlContentPart[] | string,
  results: Map<string, ToolStepOutput>
): ToolStep[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isToolCallPart).map((part) => {
    const id = typeof part.id === 'string' ? part.id : '';
    const name = typeof part.name === 'string' ? part.name : 'tool';
    return {
      id,
      name,
      input: sanitizeToolInput(part.arguments),
      output: id ? results.get(id) ?? null : null,
    };
  });
}

export function extractUserText(raw: string): string {
  const trimmed = raw.trim();
  // Preserve scheduled-task headers so the frontend can render them specially
  if (/^\[cron:/i.test(trimmed)) return trimmed;

  const match = raw
    .split('\n')
    .reverse()
    .map((l) => l.trim().match(/^\[.+?\]\s+(.+)/))
    .find((m) => m !== null);
  return match ? match[1].trim() : trimmed;
}

export function extractAssistantText(raw: string): string {
  return raw
    .replace(/<\/?final>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
    .trim();
}

function readJsonlLines(jsonlPath: string): JsonlEntry[] {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return [];
  return fs
    .readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as JsonlEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JsonlEntry => e !== null);
}

export function readFirstUserMessage(jsonlPath: string): string | null {
  try {
    const entries = readJsonlLines(jsonlPath);
    const userMsg = entries.find(
      (entry) => entry.type === 'message' && entry.message?.role === 'user'
    );
    if (!userMsg?.message) return null;
    const content = userMsg.message.content ?? [];
    const textPart = Array.isArray(content) ? content.find(isTextPart) : null;
    const rawText = textPart?.text || (typeof content === 'string' ? content : null);
    return rawText ? extractUserText(rawText).slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function parseMessagesFromJsonl(jsonlPath: string): OpenClawMessage[] {
  try {
    const entries = readJsonlLines(jsonlPath);
    /* One pre-pass to index toolResult rows by toolCallId — assistant entries
     * reference these by id rather than positionally, so a Map is the only
     * reliable way to pair them. */
    const resultsByCallId = indexToolResults(entries);

    const raw = entries
      .filter((entry) => {
        if (entry.type !== 'message') return false;
        const role = entry.message?.role;
        return role === 'user' || role === 'assistant';
      })
      .map((entry): OpenClawMessage | null => {
        const message = entry.message!;
        const { role } = message;
        const content = Array.isArray(message.content) ? message.content : [];
        const rawText = content
          .filter(isTextPart)
          .map((c) => c.text)
          .join('\n')
          .trim();
        const text = role === 'user' ? extractUserText(rawText) : extractAssistantText(rawText);
        const inlineThinkMatch = rawText.match(
          /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i
        );
        const inlineThink = inlineThinkMatch ? inlineThinkMatch[1].trim() : '';
        const structuredThink = content
          .filter(isThinkingPart)
          .map((c) => c.thinking)
          .join('\n')
          .trim();
        const thinking = [structuredThink, inlineThink].filter(Boolean).join('\n').trim() || null;
        const toolSteps = role === 'assistant' ? extractToolSteps(message.content, resultsByCallId) : [];
        /* Keep the entry if it has ANY meaningful signal: text, thinking, or
         * tool calls. Tool-only assistant turns used to be dropped here,
         * which made tool-using runs look like silent gaps in the chat. */
        if (!text && !thinking && toolSteps.length === 0) return null;
        return {
          externalId: entry.id || '',
          role,
          text,
          thinking,
          timestamp: entry.timestamp || null,
          toolSteps: toolSteps.length > 0 ? toolSteps : null,
        };
      })
      .filter((m): m is OpenClawMessage => m !== null);

    return raw.reduce<OpenClawMessage[]>((messages, msg) => {
      const prev = messages[messages.length - 1];
      if (msg.role === 'assistant' && prev?.role === 'assistant') {
        prev.text += msg.text;
        if (msg.thinking) prev.thinking = (prev.thinking || '') + msg.thinking;
        if (msg.toolSteps && msg.toolSteps.length > 0) {
          prev.toolSteps = [...(prev.toolSteps ?? []), ...msg.toolSteps];
        }
        prev.externalId = msg.externalId;
        prev.timestamp = msg.timestamp || prev.timestamp;
      } else {
        messages.push({ ...msg });
      }
      return messages;
    }, []);
  } catch {
    return [];
  }
}

export function findLastAssistantThinking(jsonlPath: string): string | null {
  try {
    if (!fs.existsSync(jsonlPath)) return null;
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').reverse();
    const assistantLine = lines.find((l) => {
      try {
        const parsed = JSON.parse(l) as JsonlEntry;
        return parsed.type === 'message' && parsed.message?.role === 'assistant';
      } catch {
        return false;
      }
    });
    if (!assistantLine) return null;
    const parsed = JSON.parse(assistantLine) as JsonlEntry;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return null;
    const thinkingPart = content.find(isThinkingPart);
    return thinkingPart?.thinking || null;
  } catch {
    return null;
  }
}
