/* eslint-disable no-console */
import { WebSocket as WsWebSocket } from 'ws';
import crypto from 'crypto';
import {
  execFileSync,
  ExecFileSyncOptionsWithStringEncoding,
  spawn,
  SpawnOptions,
  ChildProcess,
} from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  GatewayCredentials,
  GatewayRequestOpts,
  GwConnectChallengePayload,
  GwInboundMessage,
  GwResponseMessage,
  PendingRequest,
  EventListener,
  DeviceCredentials,
  AuthCredentials,
} from '../@types/gateway';
import { OpenclawConfig } from '../@types/openclaw';
import { errMsg, execErrText } from '../utils/errors';

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

/* Heartbeat — detects wedged sockets the kernel hasn't FIN-closed yet (gateway
 * killed -9, OOM-killed, host crash, NAT timeout). The `ws` library doesn't
 * surface dead peers on its own, so we ping when traffic goes idle and force a
 * `terminate()` if no pong/data comes back within the dead-window. The dead
 * timer firing → `close` event → `_scheduleReconnect()` recovers automatically. */
const HEARTBEAT_CHECK_MS = 5_000; // tick frequency of the liveness watcher
const HEARTBEAT_IDLE_PING_MS = 15_000; // no traffic for this long → send ws ping
const HEARTBEAT_DEAD_MS = 30_000; // no traffic for this long → declare dead

/* Reconnect backoff — capped exponential with jitter so a flapping gateway
 * doesn't get hammered by a tight 5s loop from every client process. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(pem: string): Buffer {
  const key = crypto.createPublicKey(pem);
  const spki = key.export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32);
}

function signPayload(privPem: string, payload: string): string {
  return base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privPem))
  );
}

export function loadGatewayCredentials(): GatewayCredentials | null {
  try {
    const identityPath = path.join(OPENCLAW_HOME, 'identity', 'device.json');
    const authPath = path.join(OPENCLAW_HOME, 'identity', 'device-auth.json');
    const configPath = path.join(OPENCLAW_HOME, 'openclaw.json');
    const device = JSON.parse(fs.readFileSync(identityPath, 'utf-8')) as DeviceCredentials;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as AuthCredentials;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as OpenclawConfig;
    return { device, auth, gatewayPort: config.gateway?.port || 18789 };
  } catch (err) {
    console.warn('[gateway] could not load credentials:', errMsg(err));
    return null;
  }
}

function isConnectChallenge(
  msg: GwInboundMessage
): msg is { type: 'event'; event: 'connect.challenge'; payload: GwConnectChallengePayload } {
  return msg.type === 'event' && msg.event === 'connect.challenge';
}

function isResponseMessage(msg: GwInboundMessage): msg is GwResponseMessage {
  return msg.type === 'res';
}

export class GatewayClient {
  ws: WsWebSocket | null = null;

  authenticated = false;

  pending = new Map<string, PendingRequest>();

  eventListeners = new Map<string, EventListener>();

  credentials: GatewayCredentials | null = null;

  reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connectPromise: Promise<boolean> | null = null;

  /** Liveness watcher; `null` between connections. */
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Wall-clock ms of the last byte received on the current socket (any
   *  inbound message OR a pong). The heartbeat compares against this. */
  lastSeenAt = 0;

  /** Successive reconnect attempts since the last successful auth. Reset to
   *  zero on auth-success so transient blips don't push us into the cap. */
  reconnectAttempts = 0;

  async ensureConnected(): Promise<boolean> {
    if (this.ws?.readyState === WsWebSocket.OPEN && this.authenticated) return true;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  _connect(): Promise<boolean> {
    return new Promise((resolve) => {
      this.credentials = loadGatewayCredentials();
      if (!this.credentials) {
        resolve(false);
        return;
      }

      const { device, auth, gatewayPort } = this.credentials;
      const url = `ws://127.0.0.1:${gatewayPort}`;
      console.log(`[gateway] connecting to ${url}...`);

      const ws = new WsWebSocket(url);
      this.ws = ws;
      this.authenticated = false;

      const timeout = setTimeout(() => {
        console.warn('[gateway] connect timeout');
        /* `terminate()` (vs `close()`) is forceful: it skips the close
         * handshake and synchronously fires the close event, so a hung
         * handshake doesn't block reconnect. */
        try {
          ws.terminate();
        } catch {
          /* idempotent */
        }
        resolve(false);
      }, 10000);

      const markAlive = (): void => {
        this.lastSeenAt = Date.now();
      };

      ws.on('open', () => {
        markAlive();
        console.log('[gateway] ws open');
      });

      /* Pongs from the server arrive as a `ws`-level frame, NOT as an
       * inbound message — track them separately to keep the liveness
       * window accurate during an idle period with no app traffic. */
      ws.on('pong', markAlive);

      ws.on('message', (data: Buffer) => {
        markAlive();
        let msg: GwInboundMessage;
        try {
          msg = JSON.parse(data.toString()) as GwInboundMessage;
        } catch {
          return;
        }

        if (isConnectChallenge(msg)) {
          const { nonce } = msg.payload;
          const role = 'operator';
          const scopes = auth.tokens?.operator?.scopes || [
            'operator.admin',
            'operator.read',
            'operator.write',
          ];
          const signedAtMs = Date.now();
          const deviceToken = auth.tokens?.operator?.token || '';
          const payload = [
            'v3',
            device.deviceId,
            'gateway-client',
            'backend',
            role,
            scopes.join(','),
            String(signedAtMs),
            deviceToken,
            nonce,
            process.platform,
            '',
          ].join('|');
          const signature = signPayload(device.privateKeyPem, payload);
          ws.send(
            JSON.stringify({
              type: 'req',
              id: crypto.randomUUID(),
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'gateway-client',
                  version: '1.0.0',
                  platform: process.platform,
                  mode: 'backend',
                },
                caps: [],
                role,
                scopes,
                auth: { deviceToken },
                device: {
                  id: device.deviceId,
                  publicKey: base64UrlEncode(derivePublicKeyRaw(device.publicKeyPem)),
                  signature,
                  signedAt: signedAtMs,
                  nonce,
                },
              },
            })
          );
          return;
        }

        if (isResponseMessage(msg)) {
          if (!this.authenticated && msg.ok) {
            this.authenticated = true;
            this.reconnectAttempts = 0;
            this._startHeartbeat();
            clearTimeout(timeout);
            console.log('[gateway] authenticated');
            resolve(true);
            return;
          }
          if (!this.authenticated && !msg.ok) {
            clearTimeout(timeout);
            console.error('[gateway] auth failed:', msg.error?.message || 'unknown');
            resolve(false);
            return;
          }
          const p = this.pending.get(msg.id);
          if (p) {
            const { payload } = msg;
            const payloadObj =
              payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
            if (p.expectFinal && payloadObj && payloadObj.status === 'accepted') {
              p.runId =
                typeof payloadObj.runId === 'string' ? (payloadObj.runId as string) : undefined;
              return;
            }
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.payload);
            else p.reject(new Error(msg.error?.message || 'gateway error'));
          }
          return;
        }

        if (msg.type === 'event') {
          this.eventListeners.forEach((listener) => listener(msg));
        }
      });

      ws.on('close', () => {
        console.log('[gateway] disconnected');
        this.authenticated = false;
        this.ws = null;
        this._stopHeartbeat();
        /* Reject every queued request synchronously so callers fail fast
         * instead of waiting for their per-request timeout (default 120s). */
        this.pending.forEach((p) => p.reject(new Error('gateway disconnected')));
        this.pending.clear();
        this.eventListeners.clear();
        clearTimeout(timeout);
        /* Always resolve the connect promise so a failed handshake unblocks
         * any awaiting `ensureConnected()` callers. `resolve` is idempotent
         * — if auth already resolved with `true`, this is a no-op. Without
         * this, a reconnect that hits ECONNREFUSED leaves `connectPromise`
         * pending forever, and every future `ensureConnected()` returns the
         * dead promise instead of starting a fresh attempt. */
        resolve(false);
        this._scheduleReconnect();
      });

      ws.on('error', (err: Error) => {
        console.error('[gateway] ws error:', err.message);
        /* Errors don't always escalate to a clean close (esp. during
         * handshake or when the peer dropped the connection abruptly).
         * Force-terminate so the close handler runs and reconnect kicks in. */
        try {
          ws.terminate();
        } catch {
          /* idempotent */
        }
      });
    });
  }

  /** Start the WS-level liveness watcher. Called immediately after auth. */
  _startHeartbeat(): void {
    this._stopHeartbeat();
    this.lastSeenAt = Date.now();
    const timer = setInterval(() => {
      const { ws } = this;
      if (!ws || ws.readyState !== WsWebSocket.OPEN) return;
      const idle = Date.now() - this.lastSeenAt;
      if (idle > HEARTBEAT_DEAD_MS) {
        console.warn(
          `[gateway] no traffic for ${idle}ms — terminating stale socket and reconnecting`
        );
        try {
          ws.terminate();
        } catch {
          /* idempotent */
        }
        return;
      }
      if (idle > HEARTBEAT_IDLE_PING_MS) {
        try {
          /* RFC 6455 ping; the server's `ws` lib auto-pongs. The pong
           * handler above bumps `lastSeenAt` so we know the peer is alive. */
          ws.ping();
        } catch {
          /* swallow — the next tick will catch a truly dead socket. */
        }
      }
    }, HEARTBEAT_CHECK_MS);
    /* Don't keep the process alive solely on the heartbeat. */
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    /* Capped exponential backoff with 50–100% jitter. The cap is small (30s)
     * because every queued caller is currently failing; we want to recover
     * fast once the gateway is back, but not hammer it during boot. */
    const expBase = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 10)
    );
    const delay = Math.round(expBase * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts += 1;
    console.log(
      `[gateway] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => {});
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    opts: GatewayRequestOpts = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WsWebSocket.OPEN) {
        reject(new Error('gateway not connected'));
        return;
      }
      const id = crypto.randomUUID();
      const timeoutMs = opts.timeoutMs || 120000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
        expectFinal: opts.expectFinal || false,
      });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  onEvent(key: string, fn: EventListener): void {
    this.eventListeners.set(key, fn);
  }

  offEvent(key: string): void {
    this.eventListeners.delete(key);
  }
}

export const gateway = new GatewayClient();

const OPENCLAW_BIN = (() => {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        process.env.OPENCLAW_BIN,
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'openclaw.cmd') : undefined,
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'openclaw.exe') : undefined,
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, 'Programs', 'openclaw', 'openclaw.exe')
          : undefined,
        path.join(os.homedir(), '.local', 'bin', 'openclaw.exe'),
      ]
    : [
        process.env.OPENCLAW_BIN,
        '/opt/homebrew/bin/openclaw',
        '/usr/local/bin/openclaw',
        path.join(os.homedir(), '.local', 'bin', 'openclaw'),
      ];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (found) return found;
  try {
    const out = execFileSync(isWin ? 'where' : 'which', ['openclaw'], {
      encoding: 'utf-8',
    })
      .toString()
      .trim();
    // `where` can return multiple matches separated by newlines — take the first.
    return out.split(/\r?\n/)[0].trim() || 'openclaw';
  } catch {
    return 'openclaw';
  }
})();

export function getOpenclawBin(): string {
  return OPENCLAW_BIN;
}

const IS_WINDOWS = process.platform === 'win32';
const NEEDS_SHELL_RE = /\.(cmd|bat)$/i;

/**
 * Cross-platform invocation of the OpenClaw CLI.
 *
 * On Windows, npm-installed CLIs are typically `.cmd` shims, which Node's
 * `execFileSync` cannot run directly without a shell. This helper transparently
 * routes those calls through `cmd.exe /d /s /c` so the rest of the codebase
 * doesn't need to know about that detail.
 *
 * NOTE: arguments are passed as separate argv entries (not concatenated into a
 * shell string), so spaces in args are handled by Node — but cmd.exe still
 * interprets `&`, `|`, `^` if they appear unquoted in user-supplied args.
 * All current call sites pass admin-controlled identifiers, not raw user input.
 */
export function ocExec(
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding
): string;
export function ocExec(args: string[], options?: Parameters<typeof execFileSync>[2]): Buffer;
export function ocExec(args: string[], options: Parameters<typeof execFileSync>[2] = {}): unknown {
  if (IS_WINDOWS && NEEDS_SHELL_RE.test(OPENCLAW_BIN)) {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', OPENCLAW_BIN, ...args], options);
  }
  return execFileSync(OPENCLAW_BIN, args, options);
}

/** Cross-platform `spawn` of the OpenClaw CLI (see {@link ocExec}). */
export function ocSpawn(args: string[], options: SpawnOptions = {}): ChildProcess {
  if (IS_WINDOWS && NEEDS_SHELL_RE.test(OPENCLAW_BIN)) {
    return spawn('cmd.exe', ['/d', '/s', '/c', OPENCLAW_BIN, ...args], options);
  }
  return spawn(OPENCLAW_BIN, args, options);
}

export async function ensureDevicePaired(): Promise<void> {
  const creds = loadGatewayCredentials();
  const scopes = creds?.auth?.tokens?.operator?.scopes || [];
  if (scopes.includes('operator.write')) {
    console.log('[setup] device-auth already has operator.write');
    return;
  }

  console.log('[setup] device-auth missing operator.write — auto-pairing...');
  const opts = { cwd: os.homedir(), env: { ...process.env, NO_COLOR: '1' }, timeout: 15000 };

  try {
    ocExec(['gateway', 'call', 'health', '--json'], opts);
  } catch {
    /* may fail with pairing required */
  }

  try {
    const out = ocExec(['devices', 'approve', '--latest', '--json'], opts).toString();
    console.log(
      '[setup] approved pending device:',
      out.includes('"requestId"') ? 'ok' : out.trim().slice(0, 200)
    );
  } catch (err) {
    const msg = execErrText(err);
    if (msg.includes('no pending')) {
      console.log('[setup] no pending pairing requests');
    } else {
      console.warn('[setup] approve failed:', msg.slice(0, 200));
    }
  }

  try {
    ocExec(['gateway', 'call', 'health', '--json'], opts);
  } catch {
    /* non-critical */
  }

  const updated = loadGatewayCredentials();
  const newScopes = updated?.auth?.tokens?.operator?.scopes || [];
  if (newScopes.includes('operator.write')) {
    console.log('[setup] device-auth now has operator.write — gateway fast-path enabled');
  } else {
    console.warn(
      '[setup] device-auth still missing operator.write — will use CLI fallback for chat'
    );
  }
}

export function getOpenclawHome(): string {
  return OPENCLAW_HOME;
}
