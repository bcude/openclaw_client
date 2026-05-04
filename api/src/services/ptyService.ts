import { Server as HttpServer } from 'http';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getOpenclawBin } from './openclawGateway';
import { consumePtyTicket } from './ptyTickets';

const IS_WINDOWS = process.platform === 'win32';

function resolveBridge(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'pty-bridge.py'),
    path.join(__dirname, '..', 'pty-bridge.py'),
    path.resolve('pty-bridge.py'),
    path.resolve('api', 'pty-bridge.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  console.error(
    `[pty] bridge script not found, tried: ${candidates.join(', ')}`
  ); /* eslint-disable-line */
  return candidates[0];
}

const BRIDGE_SCRIPT = resolveBridge();

function findBinary(name: string): string {
  const lookup = IS_WINDOWS ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, [name], { encoding: 'utf8' }).toString().trim();
    return out.split(/\r?\n/)[0].trim() || name;
  } catch {
    return name;
  }
}

function defaultCwd(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || os.tmpdir();
}

/** Strip undefined so node-pty / spawn do not get invalid env values. */
function cleanEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  Object.keys(env).forEach((k) => {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  });
  return out;
}

function isRecoverableSpawnFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // posix_spawn is the macOS/Linux case; CreateProcess is node-pty on Windows (ConPTY).
  return msg.includes('posix_spawn') || /CreateProcess/i.test(msg) || /EACCES|ENOENT/.test(msg);
}

function trySpawnNodePty(openclawBin: string, agentName: string): pty.IPty {
  const opts = {
    name: 'xterm-256color' as const,
    cols: 80,
    rows: 24,
    cwd: defaultCwd(),
    env: cleanEnv({ ...process.env, TERM: 'xterm-256color' }),
  };

  // On Windows, .cmd/.bat shims must go through cmd.exe; node-pty can't spawn them directly.
  const baseArgs = ['agents', 'add', agentName];
  const attempts: [string, string[]][] = [];
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(openclawBin)) {
    attempts.push(['cmd.exe', ['/d', '/s', '/c', openclawBin, ...baseArgs]]);
  } else {
    attempts.push([openclawBin, baseArgs]);
  }

  try {
    const resolved = fs.realpathSync(openclawBin);
    if (resolved !== openclawBin) {
      if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)) {
        attempts.push(['cmd.exe', ['/d', '/s', '/c', resolved, ...baseArgs]]);
      } else {
        attempts.push([resolved, baseArgs]);
      }
    }
  } catch {
    /* keep single attempt */
  }

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i += 1) {
    const [file, args] = attempts[i];
    try {
      return pty.spawn(file, args, opts);
    } catch (e) {
      lastErr = e;
      if (!isRecoverableSpawnFailure(e)) {
        if (e instanceof Error) throw e;
        throw new Error(String(e));
      }
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  if (lastErr) throw new Error(String(lastErr));
  throw new Error('node-pty: exhausted spawn attempts');
}

function spawnPythonBridge(
  python3Bin: string,
  openclawBin: string,
  agentName: string
): ChildProcess {
  return spawn(
    python3Bin,
    ['-u', BRIDGE_SCRIPT, '80', '24', openclawBin, 'agents', 'add', agentName],
    {
      cwd: defaultCwd(),
      env: process.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
}

function attachPythonBridge(ws: WebSocket, child: ChildProcess): void {
  child.stdout?.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data.toString());
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    console.error(`[pty] stderr: ${text}`); /* eslint-disable-line */
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  });

  child.on('error', (err) => {
    console.error(`[pty] child error: ${err.message}`); /* eslint-disable-line */
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
    }
  });

  child.on('exit', (code) => {
    console.log(`[pty] process exited with code ${code}`); /* eslint-disable-line */
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: code ?? 1 }));
      ws.close();
    }
  });

  ws.on('message', (raw: Buffer | string) => {
    const msg = raw.toString();
    if (msg.startsWith('{"type":')) {
      try {
        const ctrl = JSON.parse(msg) as { type?: string; cols?: number; rows?: number };
        if (ctrl.type === 'resize' && child.stdin?.writable) {
          child.stdin.write(`${JSON.stringify(ctrl)}\n`);
        }
      } catch {
        /* ignore */
      }
    } else if (child.stdin?.writable) {
      child.stdin.write(msg);
    }
  });

  ws.on('close', () => {
    console.log(`[pty] WebSocket closed, killing pid=${child.pid}`); /* eslint-disable-line */
    try {
      child.kill();
    } catch {
      /* already dead */
    }
  });
}

function attachNodePty(ws: WebSocket, term: pty.IPty): void {
  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  term.onExit(({ exitCode, signal }) => {
    const code = signal !== undefined ? 128 + signal : (exitCode ?? 1);
    console.log(`[pty] process exited code=${code}`); /* eslint-disable-line */
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }));
      ws.close();
    }
  });

  ws.on('message', (raw: Buffer | string) => {
    const msg = raw.toString();
    if (msg.startsWith('{"type":')) {
      try {
        const ctrl = JSON.parse(msg) as { type?: string; cols?: number; rows?: number };
        if (
          ctrl.type === 'resize' &&
          typeof ctrl.cols === 'number' &&
          typeof ctrl.rows === 'number'
        ) {
          term.resize(ctrl.cols, ctrl.rows);
        }
      } catch {
        /* ignore malformed control messages */
      }
    } else {
      term.write(msg);
    }
  });

  ws.on('close', () => {
    console.log(`[pty] WebSocket closed, killing pid=${term.pid}`); /* eslint-disable-line */
    try {
      term.kill();
    } catch {
      /* already dead */
    }
  });
}

export default function attachPtyWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const openclawBin = getOpenclawBin();
  const python3Bin = findBinary('python3');
  console.log(
    `[pty] openclaw: ${openclawBin}, python3: ${python3Bin}, bridge: ${BRIDGE_SCRIPT}`
  ); /* eslint-disable-line */

  server.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url || '', `http://${req.headers.host}`);
    if (parsed.pathname !== '/ws/pty') {
      return;
    }

    // Single-use ticket beats long-lived JWT in the URL — see
    // `services/ptyTickets.ts` for the threat model. The ticket also
    // pins the upgrade to a specific user, which we don't currently use
    // for authorization but plumb through for future per-agent ACLs.
    const ticket = parsed.searchParams.get('ticket');
    if (!consumePtyTicket(ticket)) {
      console.warn('[pty] upgrade rejected: invalid or expired ticket'); /* eslint-disable-line */
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const parsed = new URL(req.url || '', `http://${req.headers.host}`);
    const agentName = parsed.searchParams.get('agent');

    if (!agentName) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing agent parameter' }));
      ws.close();
      return;
    }

    // Python bridge is POSIX-only (fcntl/termios/forkpty); Windows uses node-pty + ConPTY.
    const forcePython = !IS_WINDOWS && process.env.PTY_BACKEND === 'python';

    if (!forcePython) {
      try {
        const term = trySpawnNodePty(openclawBin, agentName);
        console.log(
          `[pty] node-pty pid=${term.pid} agent="${agentName}"`
        ); /* eslint-disable-line */
        attachNodePty(ws, term);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const canFallback = !IS_WINDOWS && isRecoverableSpawnFailure(err);
        if (!canFallback) {
          console.error(`[pty] spawn failed: ${msg}`); /* eslint-disable-line */
          ws.send(JSON.stringify({ type: 'error', message: `Failed to start PTY: ${msg}` }));
          ws.close();
          return;
        }
        console.warn(
          `[pty] node-pty failed (${msg}), falling back to Python bridge`
        ); /* eslint-disable-line */
      }
    } else {
      console.log('[pty] PTY_BACKEND=python, skipping node-pty'); /* eslint-disable-line */
    }

    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'PTY failed: node-pty could not start and pty-bridge.py was not found. Set PTY_BACKEND=python only if Python 3 is installed.',
        })
      );
      ws.close();
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnPythonBridge(python3Bin, openclawBin, agentName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pty] Python bridge spawn failed: ${msg}`); /* eslint-disable-line */
      ws.send(JSON.stringify({ type: 'error', message: `Failed to start PTY: ${msg}` }));
      ws.close();
      return;
    }

    console.log(
      `[pty] Python bridge pid=${child.pid} agent="${agentName}"`
    ); /* eslint-disable-line */
    attachPythonBridge(ws, child);
  });

  console.log('[pty] WebSocket server attached at /ws/pty'); /* eslint-disable-line */
}
