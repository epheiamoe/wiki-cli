import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { logInfo, logWarning } from './progress.js';

const GITIGNORE_ENTRIES = ['.wiki/temp', '.wiki/sessions/'];

export function ensureGitIgnore(workDir: string): void {
  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'ignore' });
  } catch {
    return;
  }

  const gitignorePath = join(workDir, '.gitignore');
  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n').map(l => l.trim());
  const missing = GITIGNORE_ENTRIES.filter(e => !lines.includes(e));

  if (missing.length === 0) return;

  const toAppend = missing.join('\n');
  if (content && !content.endsWith('\n')) {
    appendFileSync(gitignorePath, '\n');
  }
  appendFileSync(gitignorePath, (content ? '\n' : '') + toAppend + '\n');
  logInfo(`已添加至 .gitignore: ${missing.join(', ')}`);
}

export interface EnsureRepoResult {
  updated: boolean;
}

export async function ensureRepo(url: string, targetDir: string, branch?: string, depth?: number): Promise<EnsureRepoResult> {
  const branchFlag = branch ? `--branch ${branch}` : '';
  const depthFlag = depth ? `--depth ${depth}` : '';

  if (existsSync(targetDir)) {
    logInfo(`Updating existing repo at ${targetDir}...`);
    try {
      execSync('git fetch --all', { cwd: targetDir, stdio: 'ignore' });
    } catch {
      logWarning(`Network unavailable, using cached repo at ${targetDir}`);
      return { updated: false };
    }
    try {
      if (branch) {
        execSync(`git checkout ${branch}`, { cwd: targetDir, stdio: 'pipe' });
        execSync(`git merge origin/${branch}`, { cwd: targetDir, stdio: 'pipe' });
      } else {
        execSync('git merge', { cwd: targetDir, stdio: 'pipe' });
      }
    } catch (err: any) {
      throw new Error(`Failed to update repo at ${targetDir}: ${err.message}`);
    }
    logInfo(`Repo updated at ${targetDir}`);
    return { updated: true };
  }

  logInfo(`Cloning ${url}...`);
  try {
    const cmd = `git clone ${depthFlag} ${branchFlag} ${url} "${targetDir}"`.replace(/\s+/g, ' ').trim();
    execSync(cmd, { stdio: 'inherit' });
    logInfo(`Cloned to ${targetDir}`);
    return { updated: true };
  } catch (err: any) {
    throw new Error(`Failed to clone ${url}: ${err.message}`);
  }
}
