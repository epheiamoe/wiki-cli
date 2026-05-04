import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ensureRepo } from './git.js';
import { logInfo, logError } from './progress.js';

export interface WorkDirResult {
  workDir: string;
  outputDir?: string;
  updated?: boolean;
  cleanup?: () => Promise<void>;
}

const DEFAULT_REPO_DIR = join(homedir(), '.wiki-cli', 'repos');

function getRepoDirs(): string[] {
  try {
    const cfgPath = join(homedir(), '.wiki-cli', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (cfg.repoDirs?.length) return cfg.repoDirs;
    }
  } catch { /* ignore */ }
  return [DEFAULT_REPO_DIR];
}

function urlToDirName(url: string): string {
  const cleaned = url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[\/:]/g, '-');
  return cleaned;
}

export function defaultRepoDir(url: string): string {
  return join(getRepoDirs()[0], urlToDirName(url));
}

export function findExistingRepoDir(url: string): string | null {
  const dirName = urlToDirName(url);
  for (const base of getRepoDirs()) {
    const candidate = join(base, dirName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolveWorkDir(options: {
  dir?: string;
  url?: string;
  output?: string;
  branch?: string;
  depth?: number;
  temp?: boolean;
}): Promise<WorkDirResult> {
  const { dir, url, output, branch, depth, temp } = options;

  if (url) {
    let targetDir: string = '';

    if (temp) {
      targetDir = mkdtempSync(join(tmpdir(), 'wiki-cli-'));
    } else if (output) {
      targetDir = resolve(output);
      await mkdir(targetDir, { recursive: true });
    } else {
      const existing = findExistingRepoDir(url);
      if (existing) {
        targetDir = existing;
        logInfo(`Found cached repo at ${targetDir}`);
      } else {
        targetDir = defaultRepoDir(url);
        const parent = dirname(targetDir);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
      }
    }

    const repoResult = await ensureRepo(url, targetDir, branch, depth);
    process.chdir(targetDir);
    logInfo(`Working directory: ${targetDir}`);

    if (temp) {
      return {
        workDir: targetDir,
        updated: repoResult.updated,
        cleanup: async () => {
          const { rm } = await import('node:fs/promises');
          await rm(targetDir, { recursive: true, force: true });
        },
      };
    }

    return { workDir: targetDir, updated: repoResult.updated };
  }

  // No url: use -C dir or cwd
  const workDir = dir ? resolve(dir) : process.cwd();
  if (!existsSync(workDir)) {
    throw new Error(`Directory not found: ${workDir}`);
  }

  // Checkout branch in local repo
  if (branch) {
    try {
      execSync(`git checkout ${branch}`, { cwd: workDir, stdio: 'pipe' });
      logInfo(`Switched to branch: ${branch}`);
    } catch {
      logError(`Branch "${branch}" not found or not a git repository in ${workDir}`);
      process.exit(1);
    }
  }

  process.chdir(workDir);

  // Resolve output directory for wiki
  let outputDir: string | undefined;
  if (output) {
    outputDir = resolve(output);
  }

  return { workDir, outputDir };
}
