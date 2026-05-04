import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import chalk from 'chalk';
import type { ChatMessage } from './llm-client.js';

export interface Session {
  id: string;
  created: string;
  updated: string;
  summary: string;
  messages: ChatMessage[];
}

const SESSIONS_DIR_REL = '.wiki/sessions';
const INDEX_PATH = join(homedir(), '.wiki-cli', 'sessions-index.json');

// In-memory index cache
let indexCache: Record<string, string> | null = null;

function getSessionsDir(): string {
  return join(process.cwd(), SESSIONS_DIR_REL);
}

function sessionPath(id: string): string {
  return join(getSessionsDir(), `${id}.json`);
}

function readIndex(): Record<string, string> {
  if (indexCache) return indexCache;
  try {
    if (existsSync(INDEX_PATH)) {
      const raw = readFileSync(INDEX_PATH, 'utf-8');
      indexCache = JSON.parse(raw);
    } else {
      indexCache = {};
    }
  } catch {
    indexCache = {};
  }
  return indexCache!;
}

function writeIndex(idx: Record<string, string>): void {
  indexCache = idx;
  try {
    const dir = dirname(INDEX_PATH);
    if (!existsSync(dir)) { writeFileSync(INDEX_PATH, '{}', 'utf-8'); }
    writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), 'utf-8');
  } catch { /* non-critical */ }
}

function indexAdd(id: string): void {
  const idx = readIndex();
  idx[id] = getSessionsDir();
  writeIndex(idx);
}

function indexRemove(id: string): void {
  const idx = readIndex();
  delete idx[id];
  writeIndex(idx);
}

export async function ensureSessionsDir(): Promise<void> {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export function generateSessionId(): string {
  return randomUUID().slice(0, 8);
}

export async function createSession(): Promise<Session> {
  await ensureSessionsDir();
  const id = generateSessionId();
  const now = new Date().toISOString();
  const session: Session = { id, created: now, updated: now, summary: '新会话', messages: [] };
  await writeFile(sessionPath(id), JSON.stringify(session, null, 2), 'utf-8');
  indexAdd(id);
  return session;
}

export async function listSessions(): Promise<{ id: string; created: string; updated: string; summary: string }[]> {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const sessions = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      const s = JSON.parse(raw);
      sessions.push({ id: s.id, created: s.created, updated: s.updated, summary: s.summary });
    } catch { /* skip corrupt */ }
  }
  sessions.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  return sessions;
}

export async function listAllSessions(): Promise<{ id: string; created: string; updated: string; summary: string; projectDir: string }[]> {
  const idx = readIndex();
  const all: { id: string; created: string; updated: string; summary: string; projectDir: string }[] = [];

  for (const [id, sessionsDir] of Object.entries(idx)) {
    if (!existsSync(sessionsDir)) continue;
    try {
      const raw = await readFile(join(sessionsDir, `${id}.json`), 'utf-8');
      const s = JSON.parse(raw);
      all.push({ id, created: s.created, updated: s.updated, summary: s.summary, projectDir: dirname(dirname(sessionsDir)) });
    } catch { /* skip */ }
  }

  all.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  return all;
}

export async function loadSession(id: string): Promise<Session | null> {
  // 1. Try local first
  try {
    const raw = await readFile(sessionPath(id), 'utf-8');
    return JSON.parse(raw) as Session;
  } catch { /* fall through */ }

  // 2. Try index
  const idx = readIndex();
  const sessionsDir = idx[id];
  if (sessionsDir) {
    try {
      const raw = await readFile(join(sessionsDir, `${id}.json`), 'utf-8');
      return JSON.parse(raw) as Session;
    } catch { /* fall through */ }
  }

  return null;
}

export async function saveSession(session: Session): Promise<void> {
  session.updated = new Date().toISOString();
  // Ensure the correct sessions dir exists
  const idx = readIndex();
  const knownDir = idx[session.id];
  const targetDir = knownDir || getSessionsDir();
  if (!existsSync(targetDir)) await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf-8');
  // Ensure index entry exists
  if (!knownDir) indexAdd(session.id);
}

export async function deleteSession(id: string): Promise<boolean> {
  // Try local first
  const localPath = sessionPath(id);
  if (existsSync(localPath)) {
    await rm(localPath);
    indexRemove(id);
    return true;
  }
  // Try index
  const idx = readIndex();
  const sessionsDir = idx[id];
  if (sessionsDir) {
    const p = join(sessionsDir, `${id}.json`);
    if (existsSync(p)) {
      await rm(p);
      indexRemove(id);
      return true;
    }
  }
  return false;
}

export function printSession(session: Session): void {
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      const text = msg.content || '';
      if (!text.startsWith('/')) {
        console.log(`\n${chalk.green('You >')} ${text}`);
      }
    } else if (msg.role === 'assistant') {
      console.log(`${msg.content || ''}`);
    }
  }
}

export function showSessionsTable(sessions: { id: string; created: string; updated: string; summary: string; projectDir?: string }[]): void {
  if (sessions.length === 0) {
    console.log('  (无保存的会话)');
    return;
  }

  let lastProject = '';
  for (const s of sessions) {
    if (s.projectDir && s.projectDir !== lastProject) {
      lastProject = s.projectDir;
      console.log(`\n  ${chalk.bold(s.projectDir)}`);
    }
    const date = new Date(s.updated).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const prefix = s.projectDir ? '  ' : '  ';
    console.log(`${prefix}${s.id}  ${date}  ${s.summary.slice(0, 40)}`);
  }
}
