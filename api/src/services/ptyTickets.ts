import crypto from 'crypto';

/**
 * Single-use, short-lived authorization tickets for `/ws/pty` upgrades.
 *
 * The previous flow embedded the user's long-lived JWT directly in the
 * WebSocket query string. Two reasons that's bad:
 *  1. Tokens leak into HTTP access logs, browser history, and any
 *     `Referer` headers downstream of the upgrade request.
 *  2. A 30-day token shouldn't be the credential at the boundary
 *     between an authenticated browser session and a process that
 *     proxies to a TTY — the blast radius if it leaks is huge.
 *
 * The replacement: the browser hits `POST /auth/ws-ticket` (gated by the
 * normal Bearer auth middleware), gets back a 32-byte random ticket
 * scoped to its user, and immediately uses it as `?ticket=…` on the WS
 * upgrade. The server consumes the ticket on first read; reuse is
 * rejected. Tickets self-expire after `TTL_MS` even if never consumed,
 * and a sweeper drops them from memory so a stuck client can't grow the
 * map without bound.
 */
const TTL_MS = 30_000; // 30 s — long enough for a slow tab, short enough to bound exposure
const SWEEP_MS = 60_000; // background expiry sweep cadence

interface TicketRecord {
  userId: number;
  expiresAt: number;
}

const tickets = new Map<string, TicketRecord>();

/* Background sweep — without this, tickets that the client requested
 * but never consumed (tab close, network blip) would accumulate forever.
 * `unref()` lets the Node process exit cleanly during shutdown. */
const sweep = setInterval(() => {
  const now = Date.now();
  tickets.forEach((rec, id) => {
    if (rec.expiresAt <= now) tickets.delete(id);
  });
}, SWEEP_MS);
sweep.unref?.();

export function issuePtyTicket(userId: number): string {
  const id = crypto.randomBytes(32).toString('base64url');
  tickets.set(id, { userId, expiresAt: Date.now() + TTL_MS });
  return id;
}

/**
 * Atomically validate-and-burn a ticket. Returns the userId that was
 * scoped to the ticket, or `null` if it was invalid, expired, or already
 * consumed. Callers should treat any `null` as "auth failed" — no
 * retries, no information leak about which condition tripped.
 */
export function consumePtyTicket(ticket: string | null | undefined): number | null {
  if (!ticket || typeof ticket !== 'string') return null;
  const rec = tickets.get(ticket);
  if (!rec) return null;
  /* Delete first so a concurrent upgrade racing on the same ticket can
   * only succeed once. The expiry check happens after delete to keep
   * the single-use semantics regardless of clock fuzz. */
  tickets.delete(ticket);
  if (rec.expiresAt <= Date.now()) return null;
  return rec.userId;
}

/** Test-only helper — not exported via barrel; reset the in-memory map. */
export function resetPtyTicketsForTests(): void {
  tickets.clear();
}
