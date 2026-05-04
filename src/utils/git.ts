import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logInfo, logWarning } from './progress.js';

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
