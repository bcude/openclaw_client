/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { agentWorkspacePath, mediaInboundDir } from './paths';

export const WORKSPACE_MARKDOWN_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
];

export function isAllowedWorkspaceFilename(name: string): boolean {
  return typeof name === 'string' && WORKSPACE_MARKDOWN_FILES.includes(name);
}

export interface WorkspaceMeta {
  ok: true;
  workspacePath: string;
  files: { name: string; exists: boolean }[];
}

export function getWorkspaceMeta(agentId: string): WorkspaceMeta {
  const root = agentWorkspacePath(agentId);
  const files = WORKSPACE_MARKDOWN_FILES.map((name) => ({
    name,
    exists: fs.existsSync(path.join(root, name)),
  }));
  return { ok: true, workspacePath: root, files };
}

export interface WorkspaceFile {
  ok: true;
  path: string;
  exists: boolean;
  content: string;
}

export function getWorkspaceFile(agentId: string, filename: string): WorkspaceFile {
  const fp = path.join(agentWorkspacePath(agentId), filename);
  const exists = fs.existsSync(fp);
  const content = exists ? fs.readFileSync(fp, 'utf8') : '';
  return { ok: true, path: fp, exists, content };
}

export function putWorkspaceFile(
  agentId: string,
  filename: string,
  content: string
): { ok: true; path: string } {
  const dir = agentWorkspacePath(agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, content, 'utf8');
  return { ok: true, path: fp };
}

export function getWorkspaceUploadPath(_agentId: string, filename: string): string | null {
  const safe = path.basename(filename);
  const fp = path.join(mediaInboundDir(), safe);
  return fs.existsSync(fp) ? fp : null;
}

export function appendBootstrapImageRule(
  openclawAgentId: string,
  dbAgentId: number,
  apiUrl: string
): void {
  const dir = agentWorkspacePath(openclawAgentId);
  const fp = path.join(dir, 'BOOTSTRAP.md');
  const uploadUrl = `${apiUrl}/api/agent/${dbAgentId}/workspace/uploads/<image_name>`;
  const rule = [
    '',
    '## Image generation',
    '',
    'When the user requests you generate an image, store it in',
    '~/.openclaw/media/inbound directory and in your response add',
    `markdown with the image link like this: ${uploadUrl}
     markdown format should be like this: ![image_name](${uploadUrl})
    `,
    '',
    'If the user requests you to store the image in another directory',
    'then ignore the rule above.',
    'note these rules in your long term memory so that you can use it when bootstrap file is empty.',
    '',
  ].join('\n');

  const existing = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  if (existing.includes('## Image generation')) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, existing + rule, 'utf8');
}

export function copyFileToWorkspace(
  _agentId: string,
  srcPath: string,
  originalName: string
): string {
  const dir = mediaInboundDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(originalName);
  const safeName = `${crypto.randomUUID()}${ext}`;
  const dest = path.join(dir, safeName);
  fs.copyFileSync(srcPath, dest);
  fs.unlinkSync(srcPath);
  console.log(`[files] saved ${originalName} -> ${dest}`);
  return dest;
}
