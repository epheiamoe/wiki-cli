import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ensureRepo } from './git.js';
import { logInfo } from './progress.js';

export interface WorkDirResult {
  workDir: string;
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
  process.chdir(workDir);
  return { workDir };
}
