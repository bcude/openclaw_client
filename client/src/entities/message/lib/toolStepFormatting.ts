import type { ToolStep } from '../api';

/**
 * Pull the most informative one-liner out of a tool call's arguments so
 * the collapsed header has context without forcing the user to expand.
 * Special-cases the common shapes (exec/read/write/edit) and falls back
 * to the first string field for anything else.
 */
export function summarizeInput(name: string, input: Record<string, unknown> | null): string {
  if (!input) return '';
  const candidate =
    (typeof input.command === 'string' && input.command) ||
    (typeof input.path === 'string' && input.path) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.url === 'string' && input.url) ||
    (typeof input.query === 'string' && input.query) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    '';
  if (candidate) return candidate;
  /* Generic fallback: first string-valued arg, prefixed with its key so
   * the header stays self-describing for unknown tools. */
  const first = Object.entries(input).find(([, v]) => typeof v === 'string' && v);
  if (first) return `${first[0]}: ${first[1]}`;
  return name;
}

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** Roll up per-step statuses into one summary state for the outer header. */
export function aggregateStatus(steps: ToolStep[]): 'ok' | 'error' | 'pending' {
  const hasPending = steps.some((s) => !s.output);
  const hasError = steps.some(
    (s) => s.output?.isError || (typeof s.output?.exitCode === 'number' && s.output.exitCode !== 0)
  );
  if (hasError) return 'error';
  if (hasPending) return 'pending';
  return 'ok';
}
