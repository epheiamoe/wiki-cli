import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export interface RemoteSourceInfo {
  rawBaseUrl: string;
  webUrl: string;
  commit: string;
}

function parseSshUrl(url: string): { owner: string; repo: string } | null {
  // git@github.com:user/repo.git
  const sshMatch = url.match(/git@([^:]+):(.+?)\.git$/);
  if (sshMatch) {
    const parts = sshMatch[2].split('/');
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function parseHttpsUrl(url: string): { owner: string; repo: string } | null {
  // https://github.com/user/repo.git
  // https://github.com/user/repo
  const httpsMatch = url.match(/https?:\/\/([^\/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const parts = httpsMatch[2].split('/');
    if (parts.length >= 2) return { owner: parts[0], repo: parts.slice(1).join('/').replace(/\.git$/, '') };
  }
  return null;
}

export function parseRemoteUrl(gitRemote: string, commit: string): RemoteSourceInfo | null {
  const parsed = parseSshUrl(gitRemote) || parseHttpsUrl(gitRemote);
  if (!parsed) return null;
  const { owner, repo } = parsed;
  const shortCommit = commit.replace(/^"|"$/g, '').trim();
  return {
    rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${shortCommit}`,
    webUrl: `https://github.com/${owner}/${repo}`,
    commit: shortCommit,
  };
}

export function readMetaJson(wikiDir: string): { gitCommit?: string; gitRemote?: string; generatedAt?: string } | null {
  try {
    const path = join(wikiDir, '.meta.json');
    if (!existsSync(path)) return null;
    const raw = require('node:fs').readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getRemoteSourceInfo(wikiDir: string): RemoteSourceInfo | null {
  const meta = readMetaJson(wikiDir);
  if (!meta?.gitCommit || !meta?.gitRemote) return null;
  return parseRemoteUrl(meta.gitRemote, meta.gitCommit);
}

export async function fetchRemoteSource(filePath: string, remote: RemoteSourceInfo, signal?: AbortSignal): Promise<string | null> {
  // Try raw.githubusercontent.com first
  const rawUrl = `${remote.rawBaseUrl}/${filePath.replace(/\\/g, '/')}`;
  try {
    const res = await fetch(rawUrl, { signal: signal || AbortSignal.timeout(10000) });
    if (res.ok) return await res.text();
  } catch {
    // fall through to Jina
  }

  // Fallback to Jina Reader
  try {
    const jinaUrl = `https://r.jina.ai/${rawUrl}`;
    const res = await fetch(jinaUrl, {
      signal: signal || AbortSignal.timeout(15000),
      headers: { 'Accept': 'text/markdown', 'User-Agent': 'wiki-cli/1.0' },
    });
    if (res.ok) return await res.text();
  } catch {
    // ignore
  }

  return null;
}
