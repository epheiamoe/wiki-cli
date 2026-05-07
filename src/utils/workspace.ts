import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ensureRepo } from './git.js';
import { logInfo, logError } from './progress.js';
import { moveDir, removeDir } from './file.js';

export interface WorkDirResult {
  workDir: string;
  outputDir?: string;
  updated?: boolean;
  cleanup?: () => Promise<void>;
}

const DEFAULT_REPO_DIR = join(homedir(), '.wiki-cli', 'repos');
const ARCHIVE_BASE = join(homedir(), '.wiki-cli', 'wiki-archives');

export function getRepoDirs(): string[] {
  try {
    const cfgPath = join(homedir(), '.wiki-cli', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (cfg.repoDirs?.length) return cfg.repoDirs;
    }
  } catch { /* ignore */ }
  return [DEFAULT_REPO_DIR];
}

export function urlToDirName(url: string): string {
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

export function archiveDirFor(url: string): string {
  return join(ARCHIVE_BASE, urlToDirName(url), '.wiki');
}

export function findArchiveDir(url: string): string | null {
  const dir = archiveDirFor(url);
  return existsSync(dir) ? dir : null;
}

export async function restoreWikiFromArchive(url: string, repoDir: string): Promise<boolean> {
  const archive = findArchiveDir(url);
  if (!archive) return false;
  const target = join(repoDir, '.wiki');
  if (existsSync(target)) return false;
  await moveDir(archive, target);
  logInfo(`Restored ${archive} → ${target}`);
  return true;
}

export async function moveWikiToArchive(url: string, repoDir: string): Promise<string | null> {
  const wikiDir = join(repoDir, '.wiki');
  if (!existsSync(wikiDir)) return null;
  const dest = archiveDirFor(url);
  const parent = dirname(dest);
  if (!existsSync(parent)) await mkdir(parent, { recursive: true });
  await moveDir(wikiDir, dest);
  logInfo(`Archived ${wikiDir} → ${dest}`);
  return dest;
}

/** Get wiki version count inside a directory (check .wiki/<ts>/index.json existence). */
export async function countWikiVersions(wikiDir: string): Promise<number> {
  try {
    const entries = await readdir(wikiDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions').length;
  } catch {
    return 0;
  }
}

/** Human-readable directory size */
export async function dirSize(dirPath: string): Promise<string> {
  try {
    let total = 0;
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules') continue;
          await walk(full);
        } else {
          try { total += (await stat(full)).size; } catch { /* skip */ }
        }
      }
    }
    await walk(dirPath);
    if (total < 1024) return `${total} B`;
    if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return '?';
  }
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

    const wasFreshClone = !existsSync(targetDir);
    const repoResult = await ensureRepo(url, targetDir, branch, depth);
    process.chdir(targetDir);
    logInfo(`Working directory: ${targetDir}`);

    // Restore archived wiki on fresh clone
    if (!temp && wasFreshClone) {
      const archive = findArchiveDir(url);
      if (archive) {
        const versionsInArchive = await countWikiVersions(archive);
        if (versionsInArchive > 0) {
          logInfo(`检测到存档的 Wiki 文档（${versionsInArchive} 个版本），来自 ${archive}`);
          let restore = true;
          try {
            const { default: inquirer } = await import('inquirer');
            const { ok } = await inquirer.prompt([
              { type: 'confirm', name: 'ok', message: '是否恢复存档 Wiki？', default: true },
            ]);
            restore = ok;
          } catch { /* non-interactive — restore by default */ }
          if (restore) {
            await restoreWikiFromArchive(url, targetDir);
            const { rm } = await import('node:fs/promises');
            await rm(dirname(archive), { recursive: true, force: true });
            logInfo('存档已删除（Wiki 已恢复到仓库中）');
          }
        }
      }
    }

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
