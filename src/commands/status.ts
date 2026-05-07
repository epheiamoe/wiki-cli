import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { logInfo, logWarning, logError } from '../utils/progress.js';
import { findExistingRepoDir, defaultRepoDir, findArchiveDir } from '../utils/workspace.js';
import { getRemoteSourceInfo } from '../utils/remote-source.js';
import chalk from 'chalk';
import { basename } from 'node:path';

export interface StatusOptions {
  version?: string;
  dir?: string;
  url?: string;
  log?: boolean;
  stat?: boolean;
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  // Locate wiki directory
  let wikiDir: string;

  if (options.url) {
    const repoDir = findExistingRepoDir(options.url) || defaultRepoDir(options.url);
    wikiDir = join(repoDir, '.wiki');
    if (!existsSync(wikiDir)) {
      const archive = findArchiveDir(options.url);
      if (archive) wikiDir = archive;
    }
  } else if (options.dir) {
    const base = resolve(options.dir);
    wikiDir = existsSync(join(base, '.wiki')) ? join(base, '.wiki') : base;
  } else {
    wikiDir = join(resolve(process.cwd()), '.wiki');
  }

  if (!existsSync(wikiDir)) {
    logError(`No .wiki directory found at ${wikiDir}`);
    process.exit(1);
  }

  const entries = await readdir(wikiDir, { withFileTypes: true });
  const versions = entries
    .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
    .map(e => e.name)
    .sort()
    .reverse();

  if (versions.length === 0) {
    logError('No Wiki versions found.');
    process.exit(1);
  }

  const ts = options.version || versions[0];
  if (!versions.includes(ts)) {
    logError(`Version "${ts}" not found. Available: ${versions.join(', ')}`);
    process.exit(1);
  }

  const versionDir = join(wikiDir, ts);
  const metaPath = join(versionDir, '.meta.json');

  console.log(chalk.bold(`\n📖 Wiki: ${ts}`));

  // Try to read meta
  if (!existsSync(metaPath)) {
    console.log(`   生成于:    ${chalk.dim('（无元数据）')}`);
    console.log(`   状态:      ${chalk.yellow('⚡ 该版本生成时尚未启用元数据追踪')}`);
    return;
  }

  const metaRaw = await readFile(metaPath, 'utf-8');
  const meta = JSON.parse(metaRaw);

  console.log(`   生成于:    ${meta.generatedAt || chalk.dim('未知')}`);

  if (meta.gitBranch) console.log(`   分支:      ${meta.gitBranch}`);
  if (meta.gitRemote) console.log(`   远程:      ${meta.gitRemote}`);

  const cwd = resolve(wikiDir, '..');

  // Try to compare with current git state
  let currentCommit = '';
  try {
    currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd }).trim();
  } catch { /* not a git repo */ }

  if (!meta.gitCommit) {
    console.log(`   基于提交:  ${chalk.dim('（非 git 项目）')}`);
    console.log(`   状态:      ${chalk.gray('—')}`);
    return;
  }

  if (!currentCommit) {
    const remote = getRemoteSourceInfo(wikiDir);
    console.log(`   基于提交:  ${formatCommit(meta.gitCommit)}`);
    if (remote) {
      console.log(`   远程:      ${remote.webUrl}`);
      console.log(`   状态:      ${chalk.yellow('⚠ 存档 Wiki，源码已不可用')}`);
    } else {
      console.log(`   状态:      ${chalk.yellow('⚠ 当前不在 git 仓库，无法比较')}`);
    }
    return;
  }

  // Check if the recorded commit exists
  let commitExists = false;
  try {
    execSync(`git cat-file -t ${meta.gitCommit}`, { encoding: 'utf-8', cwd, stdio: 'ignore' });
    commitExists = true;
  } catch { /* commit not found (rebased, different remote) */ }

  if (!commitExists) {
    console.log(`   基于提交:  ${formatCommit(meta.gitCommit)}`);
    console.log(`   当前 HEAD: ${formatCommit(currentCommit)}`);
    console.log(`   状态:      ${chalk.yellow('⚠ 提交记录不可用（可能经历了 rebase 或切换了 remote）')}`);
    return;
  }

  // Same commit?
  if (meta.gitCommit === currentCommit) {
    console.log(`   基于提交:  ${formatCommit(meta.gitCommit)}`);
    console.log(`   状态:      ${chalk.green('✅ Wiki 是最新的')}`);
    return;
  }

  // Count commits behind
  let behindCount = 0;
  let behindOutput = '';
  try {
    behindOutput = execSync(`git log --oneline ${meta.gitCommit}..HEAD`, { encoding: 'utf-8', cwd }).trim();
    behindCount = behindOutput ? behindOutput.split('\n').length : 0;
  } catch { behindCount = -1; }

  console.log(`   基于提交:  ${formatCommit(meta.gitCommit)}`);
  console.log(`   当前 HEAD: ${formatCommit(currentCommit)}`);

  if (behindCount > 0) {
    console.log(`   落后:      ${behindCount} commit${behindCount > 1 ? 's' : ''}`);
    console.log(`   状态:      ${chalk.yellow('⚠ Wiki 已过时')}`);

    if (options.log || options.stat) {
      console.log(`\n   ${chalk.bold('── 变更日志 ──')}`);
      const flag = options.stat ? '--stat' : '--oneline';
      try {
        const logOutput = execSync(`git log ${flag} ${meta.gitCommit}..HEAD`, { encoding: 'utf-8', cwd }).trim();
        for (const line of logOutput.split('\n')) {
          console.log(`   ${line}`);
        }
      } catch { /* ignore */ }
    }
  } else if (behindCount === 0) {
    console.log(`   落后:      0 commits`);
    console.log(`   状态:      ${chalk.green('✅ Wiki 是最新的')}`);
  } else {
    console.log(`   状态:      ${chalk.yellow('⚠ 无法比较（提交不在当前历史中）')}`);
  }
}

function formatCommit(ref: string): string {
  // Try to get a one-line summary
  try {
    const cwd = resolve(process.cwd());
    return execSync(`git log -1 --format="%h %s" ${ref}`, { encoding: 'utf-8', cwd }).trim();
  } catch {
    return ref.length > 12 ? ref.slice(0, 12) + '...' : ref;
  }
}
