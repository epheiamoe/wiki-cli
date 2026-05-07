import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { getRepoDirs, moveWikiToArchive, countWikiVersions, dirSize } from '../utils/workspace.js';
import { removeDir } from '../utils/file.js';
import { logInfo, logSuccess, logWarning, logError } from '../utils/progress.js';

export interface CacheOptions {
  ls?: boolean;
  rm?: string;
  all?: boolean;
  keepWiki?: boolean;
  yes?: boolean;
}

export async function cacheCommand(options: CacheOptions = {}): Promise<void> {
  // Determine mode
  if (options.ls) {
    await listCachedRepos();
    return;
  }

  if (options.rm || options.all) {
    await removeCachedRepos(options);
    return;
  }

  // No subcommand → interactive menu
  await interactiveCacheMenu();
}

// ─── Listing ──────────────────────────────────────────────

interface CachedRepo {
  dirName: string;
  path: string;
  hasWiki: boolean;
  wikiVersions: number;
  diskSize: string;
  lastActivity: string;
}

async function scanCachedRepos(): Promise<CachedRepo[]> {
  const results: CachedRepo[] = [];
  for (const base of getRepoDirs()) {
    if (!existsSync(base)) continue;
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const fullPath = join(base, e.name);
      const wikiPath = join(fullPath, '.wiki');
      const hasWiki = existsSync(wikiPath);
      const wikiVersions = hasWiki ? await countWikiVersions(wikiPath) : 0;
      const diskSize = await dirSize(fullPath);

      let lastActivity = '';
      try {
        const out = execSync('git log -1 --format=%ci', { cwd: fullPath, encoding: 'utf-8', stdio: 'pipe', timeout: 5000 }).trim();
        lastActivity = out || '';
      } catch {
        lastActivity = '(非 git 目录)';
      }

      results.push({
        dirName: e.name,
        path: fullPath,
        hasWiki,
        wikiVersions,
        diskSize,
        lastActivity,
      });
    }
  }
  return results;
}

async function listCachedRepos(): Promise<void> {
  const repos = await scanCachedRepos();
  if (repos.length === 0) {
    logInfo('没有缓存的仓库。');
    return;
  }

  console.log(chalk.bold(`\n📦 缓存仓库 (${repos.length} 个)\n`));
  for (const r of repos) {
    console.log(`  ${chalk.cyan(r.dirName)}`);
    console.log(`    路径:    ${r.path}`);
    console.log(`    大小:    ${r.diskSize}`);
    console.log(`    Wiki:    ${r.hasWiki ? chalk.green(`✔ ${r.wikiVersions} 个版本`) : chalk.dim('无')}`);
    console.log(`    最近:    ${r.lastActivity || chalk.dim('—')}`);
    console.log();
  }
}

// ─── Remove ───────────────────────────────────────────────

async function removeCachedRepos(options: CacheOptions): Promise<void> {
  const repos = await scanCachedRepos();
  if (repos.length === 0) {
    logInfo('没有缓存的仓库可供删除。');
    return;
  }

  let targets: CachedRepo[];

  if (options.all) {
    targets = repos;
  } else if (options.rm) {
    const name = options.rm.toLowerCase();
    targets = repos.filter(r => r.dirName.toLowerCase().includes(name));
    if (targets.length === 0) {
      logError(`未找到匹配 "${options.rm}" 的缓存仓库。`);
      return;
    }
  } else {
    return;
  }

  const keepWiki = options.keepWiki !== false;

  for (const target of targets) {
    console.log(chalk.bold(`\n📦 ${target.dirName}`));
    console.log(`  路径:    ${target.path}`);
    console.log(`  大小:    ${target.diskSize}`);

    if (target.hasWiki) {
      console.log(`  Wiki:    ${chalk.yellow(`${target.wikiVersions} 个版本`)}`);
      if (keepWiki) {
        console.log(`  操作:    存档 Wiki → 删除仓库`);
      } else {
        console.log(`  操作:    ${chalk.red('连同 Wiki 一并删除')}`);
      }
    }

    if (!options.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `删除 ${target.dirName}？`,
          default: false,
        },
      ]);
      if (!confirm) {
        logInfo('已取消。');
        continue;
      }

      if (target.hasWiki && !keepWiki) {
        const { confirmWiki } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmWiki',
            message: chalk.red(`再次确认：删除 ${target.dirName} 的 Wiki 文档（${target.wikiVersions} 个版本）？此操作不可恢复！`),
            default: false,
          },
        ]);
        if (!confirmWiki) {
          logInfo('已取消。');
          continue;
        }
      }
    }

    // Archive wiki if requested
    if (target.hasWiki && keepWiki) {
      const archived = await moveWikiToArchive(target.dirName, target.path);
      if (archived) {
        logSuccess(`Wiki 已存档至 ${archived}`);
      }
    }

    // Remove repo
    await removeDir(target.path);
    logSuccess(`已删除 ${target.dirName}`);
  }
}

// ─── Interactive Menu ─────────────────────────────────────

async function interactiveCacheMenu(): Promise<void> {
  while (true) {
    const repos = await scanCachedRepos();
    if (repos.length === 0) {
      logInfo('没有缓存的仓库。');
      return;
    }

    const choices = repos.map((r, i) => ({
      name: `  ${r.dirName}  ${chalk.dim(`${r.diskSize}  |  Wiki: ${r.wikiVersions} 个版本`)}`,
      value: i,
    }));
    choices.push({ name: chalk.green('  完成'), value: -1 });

    const { idx } = await inquirer.prompt([
      {
        type: 'list',
        name: 'idx',
        message: '选择一个缓存仓库进行操作：',
        pageSize: 20,
        choices,
      },
    ]);

    if (idx === -1) break;

    const target = repos[idx];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: `操作: ${target.dirName}`,
        choices: [
          { name: '🗑️  删除（Wiki 存档到 ~/.wiki-cli/wiki-archives/）', value: 'keep' },
          { name: '🔥  删除（连同 Wiki 一起删除）', value: 'delete' },
          { name: '↩  返回', value: 'back' },
        ],
      },
    ]);

    if (action === 'back') continue;

    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `确认删除 ${target.dirName}？`, default: false },
    ]);
    if (!confirm) continue;

    if (action === 'delete') {
      const { confirmWiki } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmWiki',
          message: chalk.red(`再次确认：删除 Wiki 文档（${target.wikiVersions} 个版本）？此操作不可恢复！`),
          default: false,
        },
      ]);
      if (!confirmWiki) continue;
      await removeDir(target.path);
      logSuccess(`已删除 ${target.dirName}（含 Wiki）`);
    } else {
      const archived = await moveWikiToArchive(target.dirName, target.path);
      if (archived) logSuccess(`Wiki 已存档至 ${archived}`);
      await removeDir(target.path);
      logSuccess(`已删除 ${target.dirName}`);
    }
  }
}
