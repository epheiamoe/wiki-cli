import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ensureRepo } from './git.js';
import { logInfo, logError } from './progress.js';

export interface WorkDirResult {
  workDir: string;
  outputDir?: string;
  cleanup?: () => Promise<void>;
}

const REPOS_DIR = join(homedir(), '.wiki-cli', 'repos');

function urlToDirName(url: string): string {
  const cleaned = url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[\/:]/g, '-');
  return cleaned;
}

export function defaultRepoDir(url: string): string {
  return join(REPOS_DIR, urlToDirName(url));
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
    let targetDir: string;

    if (temp) {
      targetDir = mkdtempSync(join(tmpdir(), 'wiki-cli-'));
    } else if (output) {
      targetDir = resolve(output);
      await mkdir(targetDir, { recursive: true });
    } else {
      targetDir = defaultRepoDir(url);
      await mkdir(REPOS_DIR, { recursive: true });
    }

    await ensureRepo(url, targetDir, branch, depth);
    process.chdir(targetDir);
    logInfo(`Working directory: ${targetDir}`);

    if (temp) {
      return {
        workDir: targetDir,
        cleanup: async () => {
          const { rm } = await import('node:fs/promises');
          await rm(targetDir, { recursive: true, force: true });
        },
      };
    }

    return { workDir: targetDir };
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
