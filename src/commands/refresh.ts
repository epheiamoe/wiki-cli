import { execSync } from 'node:child_process';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig } from '../config/config-store.js';
import { LLMClient } from '../ai/llm-client.js';
import type { ChatMessage } from '../ai/llm-client.js';
import { renderPrompt } from '../ai/prompts.js';
import { initTools, getFilteredTools, executeToolCall, setRemoteFallback } from '../ai/tools.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { toSlug, writeTextFile, getTimestamp } from '../utils/file.js';
import { findExistingRepoDir, defaultRepoDir } from '../utils/workspace.js';
import { logInfo, logSuccess, logWarning, logError, logToolCall, logToolResult } from '../utils/progress.js';
import { formatTerminalDiff } from '../utils/terminal-diff.js';

export interface RefreshOptions {
  slugs?: string[];
  reason?: string;
  yes?: boolean;
  retry?: number;
  dir?: string;
  url?: string;
}

interface PageInfo {
  title: string;
  slug: string;
  level: string;
}

export async function refreshCommand(options: RefreshOptions = {}): Promise<void> {
  // ── Resolve wiki directory ──
  let wikiDir: string;
  if (options.dir) {
    const base = resolve(options.dir);
    if (existsSync(base) && basename(base) !== '.wiki') {
      const nested = join(base, '.wiki');
      wikiDir = existsSync(nested) ? nested : base;
    } else {
      wikiDir = base;
    }
  } else if (options.url) {
    const repoDir = findExistingRepoDir(options.url) || defaultRepoDir(options.url);
    wikiDir = join(repoDir, '.wiki');
  } else {
    wikiDir = join(resolve(process.cwd()), '.wiki');
  }

  if (!existsSync(wikiDir)) {
    logError(`Wiki directory not found: ${wikiDir}`);
    process.exit(1);
  }

  const projectRoot = resolve(wikiDir, '..');

  // ── Find latest version ──
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

  const latest = versions[0];
  const versionDir = join(wikiDir, latest);

  // ── Check wiki is up-to-date ──
  const metaPath = join(versionDir, '.meta.json');
  if (!existsSync(metaPath)) {
    logError('当前版本缺少元数据，无法确认是否最新。请先运行 wiki-cli generate');
    process.exit(1);
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  let currentCommit = '';
  try {
    currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: projectRoot }).trim();
  } catch { /* not a git repo */ }

  if (meta.gitCommit && currentCommit && meta.gitCommit !== currentCommit) {
    logError('Wiki 已过时，请先运行 wiki-cli generate --update');
    logInfo(`  Wiki 基于: ${meta.gitCommit.slice(0, 8)}`);
    logInfo(`  当前 HEAD: ${currentCommit.slice(0, 8)}`);
    process.exit(1);
  }

  // ── Load outline ──
  const indexJsonPath = join(versionDir, 'index.json');
  let allPages: PageInfo[] = [];
  if (existsSync(indexJsonPath)) {
    try {
      const raw = readFileSync(indexJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      for (const sec of parsed.sections || []) {
        for (const t of sec.topics || []) {
          if (t.type === 'group') continue;
          const slug = toSlug(t.title);
          allPages.push({ title: t.title, slug, level: t.level || '中级' });
        }
      }
    } catch { /* ignore */ }
  }

  if (allPages.length === 0) {
    logError('无法读取 Wiki 目录结构。');
    process.exit(1);
  }

  // ── Determine target pages ──
  let targetSlugs: string[];
  if (options.slugs && options.slugs.length > 0) {
    const invalid = options.slugs.filter(s => !allPages.find(p => p.slug === s));
    if (invalid.length > 0) {
      logError(`以下页面不存在: ${invalid.join(', ')}`);
      logInfo(`可用页面: ${allPages.map(p => p.slug).join(', ')}`);
      return;
    }
    targetSlugs = options.slugs;
  } else {
    const choices = allPages.map(p => ({
      name: `${chalk.dim(p.level)} ${p.title}`,
      value: p.slug,
    }));
    const { selected } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selected',
        message: '选择要刷新的页面:',
        pageSize: 20,
        choices,
      },
    ]);
    if (selected.length === 0) {
      logInfo('未选择任何页面。');
      return;
    }
    targetSlugs = selected;
  }

  // ── Ask for reason (interactive) ──
  let reason = options.reason || '';
  if (!reason && !options.yes) {
    const { r } = await inquirer.prompt([
      {
        type: 'input',
        name: 'r',
        message: '刷新原因（可选，按 Enter 跳过）:',
      },
    ]);
    reason = r || '';
  }

  // ── Load config + init AI ──
  const config = await loadConfig();
  if (!config) {
    logError('未配置 LLM。请先运行 wiki-cli config');
    process.exit(1);
  }

  const webConfig = !config.webFetchDisabled
    ? { baseUrl: config.webFetchBaseUrl || 'https://r.jina.ai', apiKey: config.webFetchApiKey }
    : { disabled: true as const, baseUrl: '', apiKey: '' };

  if (config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey) {
    initTools(
      { provider: config.embeddingProvider || '', model: config.embeddingModel, baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey },
      webConfig,
      projectRoot
    );
  } else {
    initTools(undefined, webConfig, projectRoot);
  }

  const client = new LLMClient(config);

  // ── Collect page cross-reference info ──
  const availablePages = allPages
    .filter(p => p.slug)
    .map(p => `- slug: ${p.slug}.md | 标题: ${p.title}`)
    .join('\n');

  const osInfo = `${process.platform} ${process.arch}`;
  const maxRetries = options.retry ?? 3;

  // ── Track renames from TITLE directive (for cross-ref fix) ──
  const p2Renames: Array<{ from: string; to: string; title: string }> = [];

  // ── Process each page ──
  for (const slug of targetSlugs) {
    const page = allPages.find(p => p.slug === slug)!;

    logInfo(`[${targetSlugs.indexOf(slug) + 1}/${targetSlugs.length}] 刷新: ${page.title}`);

    await refreshOne(client, config, versionDir, page, reason, availablePages, osInfo,
      options.yes ?? false, maxRetries, p2Renames);
  }

  // ── Cross-reference fix for TITLE renames ──
  if (p2Renames.length > 0) {
    logInfo('修复交叉引用...');
    let fixCount = 0;
    const files = readdirSync(versionDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const pagePath = join(versionDir, file);
      let content = readFileSync(pagePath, 'utf-8');
      let changed = false;
      for (const r of p2Renames) {
        for (const ref of [`](${r.from}.md)`, `](${r.from})`]) {
          const replacement = ref.endsWith('.md)') ? `](${r.to}.md)` : `](${r.to})`;
          if (content.includes(ref)) {
            content = content.split(ref).join(replacement);
            changed = true;
          }
        }
      }
      if (changed) {
        writeFileSync(pagePath, content, 'utf-8');
        fixCount++;
      }
    }
    if (fixCount > 0) logInfo(`已修复 ${fixCount} 个页面的交叉引用`);
  }

  // ── Update metadata ──
  const newMeta = { ...meta, generatedAt: getTimestamp() };
  try {
    newMeta.gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: projectRoot }).trim();
  } catch { /* ignore */ }
  await writeFile(metaPath, JSON.stringify(newMeta, null, 2));

  // ── Update .page-content.json ──
  const contentPath = join(versionDir, '.page-content.json');
  if (existsSync(contentPath)) {
    const oldContent = JSON.parse(readFileSync(contentPath, 'utf-8'));
    for (const r of p2Renames) {
      if (oldContent[r.from]) {
        oldContent[r.to] = oldContent[r.from];
        delete oldContent[r.from];
      }
    }
    writeFileSync(contentPath, JSON.stringify(oldContent, null, 2));
  }

  logSuccess('刷新完成。');
}

async function refreshOne(
  client: LLMClient,
  config: WikiCliConfig,
  versionDir: string,
  page: PageInfo,
  reason: string,
  availablePages: string,
  osInfo: string,
  autoApply: boolean,
  maxRetries: number,
  p2Renames: Array<{ from: string; to: string; title: string }>
): Promise<void> {
  // Read old content
  const oldPath = join(versionDir, `${page.slug}.md`);
  if (!existsSync(oldPath)) {
    logWarning(`页面文件不存在: ${page.slug}.md，跳过`);
    return;
  }
  const oldContent = readFileSync(oldPath, 'utf-8');

  const sysVars = {
    workDir: resolve(versionDir, '..'),
    os: osInfo,
    pageTitle: page.title,
    audienceLevel: page.level,
  };
  const userVars = {
    workDir: resolve(versionDir, '..'),
    pageTitle: page.title,
    pageSlug: page.slug,
    audienceLevel: page.level,
    lang: config.lang,
    oldContent,
    availablePages,
    reason: reason ? `## 刷新原因\n${reason}\n` : '',
  };

  const systemPrompt = await renderPrompt('page-system.md', sysVars);
  const userPrompt = await renderPrompt('refresh-user.md', userVars);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // LLM call with retry
  let newContent: string | null = null;
  let attempts = 0;
  while (attempts <= maxRetries && newContent === null) {
    attempts++;
    try {
      newContent = await collectFullRefresh(client, messages, config);
    } catch (err: any) {
      logError(`生成失败: ${err.message}`);
      if (attempts <= maxRetries) {
        if (autoApply) {
          logInfo(`重试 (${attempts}/${maxRetries})...`);
          continue;
        }
        const { retry } = await inquirer.prompt([
          {
            type: 'list',
            name: 'retry',
            message: `"${page.title}" 生成失败。操作:`,
            choices: [
              { name: '🔄 重试', value: 'retry' },
              { name: '⏭️  跳过', value: 'skip' },
              { name: '🚪 退出', value: 'exit' },
            ],
          },
        ]);
        if (retry === 'retry') continue;
        if (retry === 'skip') return;
        if (retry === 'exit') process.exit(0);
      }
    }
  }

  if (newContent === null) {
    logError(`"${page.title}" 生成失败，已跳过`);
    return;
  }

  // ── Handle TITLE directive ──
  let finalSlug = page.slug;
  let finalTitle = page.title;
  const renameMatch = newContent.match(/^TITLE:\s*(.+)$/m);
  const writeContent = renameMatch
    ? newContent.replace(/^TITLE:\s*.*\n?/m, '').trim()
    : newContent;

  if (renameMatch) {
    const newTitle = renameMatch[1].trim();
    const newSlug = toSlug(newTitle);
    if (newSlug && newSlug !== page.slug) {
      const conflictPath = join(versionDir, `${newSlug}.md`);
      if (!existsSync(conflictPath)) {
        logInfo(`  重命名: "${page.title}" → "${newTitle}"`);
        p2Renames.push({ from: page.slug, to: newSlug, title: newTitle });
        finalSlug = newSlug;
        finalTitle = newTitle;
      } else {
        logWarning(`  重命名冲突 "${newSlug}"，保留原始标题`);
      }
    }
  }

  const newFilePath = join(versionDir, `${finalSlug}.md`);

  // ── Show diff + confirm ──
  if (!autoApply) {
    console.log(`\n${chalk.bold(`=== ${page.title} ===`)}`);
    console.log(chalk.cyan(`--- ${page.slug}.md`));
    console.log(chalk.cyan(`+++ ${finalSlug}.md`));
    console.log(formatTerminalDiff(oldContent, writeContent));
    console.log();

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '应用此变更？',
        choices: [
          { name: '✅ 应用', value: 'apply' },
          { name: '📄 查看完整新版本', value: 'preview' },
          { name: '⏭️  跳过', value: 'skip' },
        ],
      },
    ]);

    if (action === 'skip') {
      logInfo('已跳过。');
      return;
    }

    if (action === 'preview') {
      console.log(`\n${chalk.bold(writeContent)}\n`);
      const { confirm } = await inquirer.prompt([
        {
          type: 'list',
          name: 'confirm',
          message: '应用此变更？',
          choices: [
            { name: '✅ 应用', value: 'apply' },
            { name: '⏭️  跳过', value: 'skip' },
          ],
        },
      ]);
      if (confirm === 'skip') {
        logInfo('已跳过。');
        return;
      }
    }
  }

  // ── Write ──
  await writeFile(newFilePath, writeContent, 'utf-8');

  // ── Handle old slug cleanup on rename ──
  if (finalSlug !== page.slug) {
    if (existsSync(oldPath)) {
      const { rm } = await import('node:fs/promises');
      await rm(oldPath);
    }
  }

  const displayTitle = finalTitle !== page.title ? `${page.title} → ${finalTitle}` : finalTitle;
  logSuccess(`已刷新: ${displayTitle}`);
}

async function collectFullRefresh(
  client: LLMClient,
  messages: ChatMessage[],
  config: WikiCliConfig
): Promise<string> {
  let accumulatedContent = '';
  let iteration = 0;
  const maxIterations = 30;

  while (iteration < maxIterations) {
    iteration++;
    let hasToolCalls = false;
    let currentContent = '';
    let currentReasoning = '';
    let reasoningStarted = false;
    let contentStarted = false;
    const toolCallsMap = new Map<string, any>();

    const streamIter = client.chatStream(messages, getFilteredTools());

    try {
      for await (const chunk of streamIter) {
        if (chunk.type === 'reasoning' && chunk.reasoning_content) {
          currentReasoning += chunk.reasoning_content;
          if (!reasoningStarted) {
            reasoningStarted = true;
            process.stdout.write(chalk.dim.yellow('\nThinking: '));
          }
          process.stdout.write(chalk.dim.yellow(chunk.reasoning_content));
        } else if (chunk.type === 'content') {
          if (!contentStarted && reasoningStarted) {
            contentStarted = true;
            console.log('');
          }
          currentContent += chunk.content ?? '';
          process.stdout.write(chunk.content ?? '');
        } else if (chunk.type === 'tool_call' && chunk.tool_call) {
          hasToolCalls = true;
          const tc = chunk.tool_call;
          const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
          if (toolCallsMap.has(key)) {
            const existing = toolCallsMap.get(key)!;
            existing.function.arguments += tc.function.arguments;
          } else {
            toolCallsMap.set(key, { ...tc });
          }
        } else if (chunk.type === 'error') {
          throw new Error(chunk.error || 'LLM stream error');
        }
      }
    } catch (err: any) {
      throw new Error(`Stream error: ${err.message}`);
    }

    if (currentContent) {
      accumulatedContent += currentContent;
    }

    if (!hasToolCalls) {
      messages.push({
        role: 'assistant',
        content: currentContent || null,
        reasoning_content: currentReasoning || null,
      });
      console.log();
      return currentContent;
    }

    const toolCalls = [...toolCallsMap.values()];
    messages.push({
      role: 'assistant',
      content: currentContent || null,
      reasoning_content: currentReasoning || null,
      tool_calls: toolCalls.map((tc: any) => ({ id: tc.id, type: 'function' as const, function: tc.function })),
    });

    console.log();

    for (const tc of toolCalls) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      logToolCall(tc.function.name, args);
      const result = await executeToolCall(tc.function.name, args);
      logToolResult(tc.function.name, result);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
    }
  }

  return accumulatedContent || '';
}
