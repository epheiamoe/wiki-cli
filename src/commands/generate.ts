import { execSync } from 'node:child_process';
import { writeFile, readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import inquirer from 'inquirer';
import { loadConfig } from '../config/config-store.js';
import { LLMClient, stripCodeFence } from '../ai/llm-client.js';
import type { ChatMessage, ToolCall } from '../ai/llm-client.js';
import { renderPrompt } from '../ai/prompts.js';
import { toolDefinitions, executeToolCall, initTools, getFilteredTools } from '../ai/tools.js';
import type { ToolDefinition } from '../ai/tools.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { ensureDir, writeTextFile, moveDir, getTimestamp, toSlug, removeDir } from '../utils/file.js';
import { resolveWorkDir } from '../utils/workspace.js';
import { ensureGitIgnore } from '../utils/git.js';
import { getChangedFiles, getAffectedSlugs, isExcludedFile } from '../utils/diff.js';
import type { PageDeps, ChangedFile } from '../utils/diff.js';
import { ProgressGrid } from '../utils/progress-grid.js';
import chalk from 'chalk';
import { logInfo, logSuccess, logWarning, logError, logToolCall, logToolResult } from '../utils/progress.js';

const TEMP_DIR = '.wiki/temp';

// Page dependency tracking (written after generation)
let _currentPageSlug: string | null = null;
const _pageDeps: Record<string, Array<{ file: string; lines: [number, number] }>> = {};
const _pageContent: Record<string, string> = {};

type PageProgressFn = (type: 'thinking' | 'tool' | 'done', detail: string) => void;

interface Topic {
  title: string;
  level: string;
  slug: string;
  section: string;
  description?: string;
  task?: string;
  isGroup?: boolean;
}

export interface GenerateOptions {
  dir?: string;
  url?: string;
  output?: string;
  branch?: string;
  depth?: number;
  temp?: boolean;
  parallel?: boolean;
  concurrency?: number;
  retry?: number;
  silent?: boolean;
  browse?: boolean;
  update?: boolean;
}

export async function generateCommand(opts: GenerateOptions = {}): Promise<void> {
  const { cleanup, outputDir, updated } = await resolveWorkDir({
    dir: opts.dir,
    url: opts.url,
    output: opts.output,
    branch: opts.branch,
    depth: opts.depth,
    temp: opts.temp,
  });

  // Register signal handler for temp-mode cleanup
  let cleanupDone = false;
  const runCleanup = async (): Promise<void> => {
    if (!cleanup || cleanupDone) return;
    cleanupDone = true;
    await cleanup();
  };
  if (cleanup) {
    const onSignal = async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await cleanup();
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  const workDir = resolve(process.cwd());

  ensureGitIgnore(workDir);

  // Repo not updated (network fallback) and wiki already exists → ask user
  if (updated === false) {
    const wikiDirForCheck = join(workDir, '.wiki');
    if (existsSync(wikiDirForCheck)) {
      const dirs = readdirSync(wikiDirForCheck, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
        .map(e => e.name)
        .sort()
        .reverse();
      if (dirs.length > 0) {
        const existingPath = join(wikiDirForCheck, dirs[0]);
        if (opts.silent) {
          logWarning(`仓库未更新，使用已有 Wiki: ${existingPath}`);
          return;
        }
        const { regen } = await inquirer.prompt([
          { type: 'confirm', name: 'regen', message: '仓库没有更新，已有 Wiki 文档，是否重新生成？', default: false },
        ]);
        if (!regen) {
          logInfo('跳过生成。');
          const { open } = await inquirer.prompt([
            { type: 'confirm', name: 'open', message: '打开已有 Wiki 文档？', default: true },
          ]);
          if (open) {
            const { browseCommand } = await import('./browse.js');
            await browseCommand({ path: existingPath });
          }
          return;
        }
      }
    }
  }

  const config = await loadConfig();
  if (!config) {
    logError('No configuration found. Run "wiki-cli config" first.');
    process.exit(1);
  }

  if (existsSync(TEMP_DIR)) {
    if (opts.silent) {
      await removeDir(TEMP_DIR);
    } else {
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Previous generation temp data found. What do you want to do?',
          choices: [
            { name: '🔄 Resume from last checkpoint', value: 'resume' },
            { name: '🗑️  Discard and start fresh', value: 'fresh' },
          ],
        },
      ]);
      if (action === 'fresh') await removeDir(TEMP_DIR);
    }
  }

  if (!existsSync(TEMP_DIR)) {
    await ensureDir(TEMP_DIR);
  }

  const client = new LLMClient(config);

  // Initialize tools with web fetch config
  const webConfig = !config.webFetchDisabled ? { baseUrl: config.webFetchBaseUrl || 'https://r.jina.ai', apiKey: config.webFetchApiKey } : { disabled: true, baseUrl: '', apiKey: '' };
  initTools(undefined, webConfig, workDir);

  let topics: Topic[];
  let updatePlan: UpdatePlan | null = null;

  if (opts.update) {
    const result = await resolveAndRunUpdate(client, config, workDir, opts);
    if (!result) return;
    topics = result.topics;
    updatePlan = result.updatePlan;
  } else {
    logInfo('Phase 1: Analyzing repository and generating outline...');
    topics = await generateOutline(client, config, workDir);
    if (topics.length === 0) {
      logError('Failed to generate outline. No topics found.');
      process.exit(1);
    }
    const pageCount = topics.filter(t => !t.isGroup).length;
    logSuccess(`Generated ${topics.length} topics (${pageCount} pages).`);
  }

  // No pages to update/add/remove — fast exit, no new version
  if (opts.update && updatePlan && updatePlan.action === 'update' && (updatePlan.update?.length ?? 0) === 0 && (updatePlan.add?.length ?? 0) === 0 && (updatePlan.remove?.length ?? 0) === 0) {
    logSuccess('Wiki 已是最新，无需更新');
    // Update meta.json in place so status reflects current commit
    try {
      const dirs = readdirSync(join(workDir, '.wiki'), { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
        .map(e => e.name).sort().reverse();
      if (dirs.length > 0) {
        const metaPath = join(workDir, '.wiki', dirs[0], '.meta.json');
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          meta.generatedAt = getTimestamp();
          try { meta.gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: workDir }).trim(); } catch { /* ignore */ }
          try { meta.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: workDir }).trim(); } catch { /* ignore */ }
          await writeFile(metaPath, JSON.stringify(meta, null, 2));
        }
      }
    } catch { /* ignore */ }
    await removeDir(TEMP_DIR);
    await runCleanup();
    return;
  }

  // For --update mode, parallel/concurrency still works but some pages are skipped
  let parallel: boolean;
  let concurrency: number;

  if (opts.silent) {
    parallel = opts.parallel || false;
    concurrency = opts.concurrency || 3;
  } else if (opts.parallel !== undefined) {
    parallel = opts.parallel;
    concurrency = opts.concurrency || 3;
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'parallel',
        message: 'Generate pages in parallel? (faster, no streaming output)',
        default: false,
      },
      {
        type: 'number',
        name: 'concurrency',
        message: 'Number of concurrent page generations:',
        default: 3,
        when: (a: any) => a.parallel,
        validate: (i: any) => (i as number) > 0 && (i as number) <= 10 ? true : 'Enter 1-10',
      },
    ]);
    parallel = answers.parallel;
    concurrency = answers.concurrency || 3;
  }

  // In update mode, old page content is already resolved; for full gen, use empty cache
  const updateMode = !!updatePlan;
  const oldContentCache: Record<string, string> = {};
  let changedFilesInfo = '';
  if (updateMode) {
    try {
      const wd = workDir;
      const latestDir2 = join(wd, '.wiki', readdirSync(join(wd, '.wiki'), { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
        .map(e => e.name).sort().reverse()[0]);
      const contentPath2 = join(latestDir2, '.page-content.json');
      if (existsSync(contentPath2)) {
        Object.assign(oldContentCache, JSON.parse(readFileSync(contentPath2, 'utf-8')));
      }
      const meta2 = JSON.parse(readFileSync(join(latestDir2, '.meta.json'), 'utf-8'));
      if (meta2.gitCommit) {
        changedFilesInfo = execSync(`git diff ${meta2.gitCommit}..HEAD --name-only`, { encoding: 'utf-8', cwd: wd }).trim()
          .split('\n')
          .filter(l => !l.startsWith('.wiki/') && l !== '.wiki' && !isExcludedFile(l))
          .join('\n');
      }
    } catch { /* ignore */ }
  }

  // Map old content for renamed pages so Phase 2 sees the original text
  if (updatePlan) {
    for (const r of updatePlan.rename ?? []) {
      if (oldContentCache[r.from] && !oldContentCache[r.to]) {
        oldContentCache[r.to] = oldContentCache[r.from];
      }
    }
  }

  const pageGenOptions: PageGenOptions = {
    parallel, concurrency,
    updateMode, oldContentCache, changedFilesInfo,
  };

  logInfo('Phase 2: Generating Wiki pages...');
  let failed = await generatePages(client, config, workDir, topics, pageGenOptions);

  let retriesLeft = opts.retry ?? 0;
  while (failed.length > 0 && retriesLeft > 0) {
    logWarning(`${failed.length} page(s) failed. Retrying (${retriesLeft} left)...`);
    const retryResult = await generatePages(client, config, workDir, topics, { ...pageGenOptions, retryList: [...failed] });
    failed = retryResult;
    retriesLeft--;
  }

  if (!opts.silent) {
    while (failed.length > 0) {
      logWarning(`${failed.length} page(s) failed to generate.`);
      const { retry } = await inquirer.prompt([
        { type: 'confirm', name: 'retry', message: 'Retry failed pages?', default: true },
      ]);
      if (!retry) break;
      logInfo(`Retrying ${failed.length} page(s)...`);
      const r = await generatePages(client, config, workDir, topics, { ...pageGenOptions, retryList: [...failed] });
      failed = r;
    }
  }

  if (failed.length > 0) {
    logWarning(`${failed.length} page(s) were not generated successfully.`);
  }

  const timestamp = getTimestamp();
  const finalDir = outputDir || join('.wiki', timestamp);
  const absPath = resolve(finalDir);
  await moveDir(TEMP_DIR, finalDir);
  logSuccess(`Wiki generated at ${absPath}`);

  await generateIndex(finalDir, topics);
  logSuccess('Index file generated.');

  // Write metadata
  const meta: Record<string, string> = { generatedAt: getTimestamp() };
  try {
    meta.gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: workDir }).trim();
  } catch { /* not a git repo */ }
  try {
    meta.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: workDir }).trim();
  } catch { /* not a git repo */ }
  try {
    meta.gitRemote = execSync('git remote get-url origin', { encoding: 'utf-8', cwd: workDir }).trim();
  } catch { /* no remote */ }
  await writeFile(join(finalDir, '.meta.json'), JSON.stringify(meta, null, 2));

  // Save page dependency and content metadata
  await savePageMetadata(finalDir);
  logSuccess('Page metadata saved.');

  if (opts.browse) {
    logInfo('Starting browse server...');
    const { browseCommand } = await import('./browse.js');
    await browseCommand({ path: absPath });
    return;
  }

  if (opts.silent) {
    console.log(`Result: ${topics.filter(t => !t.isGroup).length} pages, ${failed.length} failed`);
    await runCleanup();
    return;
  }

  const { open } = await inquirer.prompt([
    { type: 'confirm', name: 'open', message: `Wiki 已生成于 ${absPath}，打开浏览器查看？`, default: true },
  ]);
  if (open) {
    const { browseCommand } = await import('./browse.js');
    await browseCommand({ path: absPath });
    return;
  }

  await runCleanup();
}

async function generateOutline(client: LLMClient, config: WikiCliConfig, workDir: string): Promise<Topic[]> {
  const osInfo = `${process.platform} ${process.arch}`;
  const outlineSysVars = { workDir, os: osInfo };
  const outlineUserVars = { workDir, os: osInfo, lang: config.lang };

  const systemPrompt = await renderPrompt('outline-system.md', outlineSysVars);
  const userPrompt = await renderPrompt('outline-user.md', outlineUserVars);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const useJsonMode = config.jsonMode === true;

  let finalContent = '';
  const maxIterations = 25;

  for (let i = 0; i < maxIterations; i++) {
    logInfo(`Phase 1 / Round ${i + 1} (streaming below)...`);

    try {
      const fullContent = await collectFullResponse(client, messages, config, true, useJsonMode);

      if (!fullContent) {
        logError('No response from LLM');
        break;
      }

      finalContent = fullContent;

      // Try to parse as JSON
      const topics = parseOutlineJson(fullContent);
      if (topics.length > 0) {
        logSuccess('Outline generated successfully.');
        await writeTextFile(join(TEMP_DIR, '_outline.json'), fullContent);
        return topics;
      }

      // If no JSON found, continue the conversation
      const response: ChatMessage = { role: 'assistant', content: fullContent };
      logSuccess(`Got ${fullContent.length} chars of response (no valid JSON found).`);
      messages.push(response);

    } catch (err: any) {
      logError(`Error: ${err.message}`);
      break;
    }
  }

  // Final attempt to parse whatever we have
  if (finalContent) {
    const topics = parseOutlineJson(finalContent);
    if (topics.length > 0) return topics;
  }

  return [];
}

interface UpdatePlan {
  action: 'update' | 'restructure';
  update?: string[];
  add?: Topic[];
  remove?: string[];
  rename?: { from: string; to: string; title: string }[];
}

async function updateAnalysis(
  client: LLMClient,
  config: WikiCliConfig,
  workDir: string,
  oldOutline: object,
  changedFiles: string[],
  affectedSlugs: string[],
  pageDeps: PageDeps,
  pageContentCache: Record<string, string>,
  addedFiles: string[]
): Promise<UpdatePlan> {
  const osInfo = `${process.platform} ${process.arch}`;
  const sysVars = { workDir, os: osInfo };
  const systemPrompt = await renderPrompt('update-system.md', sysVars);

  const changedSummary = changedFiles.map(f => {
    const deps = Object.entries(pageDeps)
      .filter(([, deps]) => deps[f])
      .map(([slug]) => slug);
    return `- ${f} 影响页面: ${deps.join(', ') || '(无)'}`;
  }).join('\n');

  const candidatesInfo = affectedSlugs.map(slug => {
    const deps = pageDeps[slug];
    if (!deps) return `- ${slug}.md: (无依赖记录)`;
    const depLines = Object.entries(deps)
      .map(([f, ranges]) => `    ${f}: ${ranges.map(r => `[${r[0]}-${r[1]}]`).join(', ')}`)
      .join('\n');
    return `- ${slug}.md:\n${depLines}`;
  }).join('\n');

  const pageContents = affectedSlugs.map(slug =>
    `### ${slug}.md\n${pageContentCache[slug] || '(无缓存)'}`
  ).join('\n\n');

  const newFiles = addedFiles.length > 0
    ? addedFiles.map(f => `- ${f}`).join('\n')
    : '(无)';

  const userVars = {
    workDir,
    outline: JSON.stringify(oldOutline, null, 2),
    changedSummary,
    candidatesInfo,
    pageContents,
    newFiles,
    lang: config.lang,
  };
  const userPrompt = await renderPrompt('update-user.md', userVars);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const useJsonMode = config.jsonMode === true;

  let finalContent = '';
  const maxIterations = 8;

  for (let i = 0; i < maxIterations; i++) {
    logInfo(`更新分析 / Round ${i + 1}...`);

    try {
      const fullContent = await collectFullResponse(
        client, messages, config, true, useJsonMode,
        getFilteredTools()
      );

      if (!fullContent) {
        logError('更新分析无响应');
        break;
      }

      finalContent = fullContent;
      const cleaned = stripCodeFence(fullContent);
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.action === 'restructure') {
          logSuccess('LLM 判定需要整体重构');
          return { action: 'restructure' };
        }
        if (parsed.action === 'update') {
          const plan: UpdatePlan = {
            action: 'update',
            update: parsed.update || [],
            add: parsed.add || [],
            remove: parsed.remove || [],
            rename: parsed.rename || [],
          };
          logSuccess(`更新分析完成: ${(plan.update || []).length} 个页面需更新, ${(plan.add || []).length} 个需新增, ${(plan.remove || []).length} 个需移除`);
          return plan;
        }
      }

      const response: ChatMessage = { role: 'assistant', content: fullContent };
      messages.push(response);

    } catch (err: any) {
      logError(`错误: ${err.message}`);
      break;
    }
  }

  if (finalContent) {
    const cleaned = stripCodeFence(finalContent);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.action === 'restructure') return { action: 'restructure' };
        if (parsed.action === 'update') {
          return { action: 'update', update: parsed.update || [], add: parsed.add || [], remove: parsed.remove || [], rename: parsed.rename || [] };
        }
      } catch { /* ignore */ }
    }
  }

  logWarning('无法解析更新计划，默认全部更新');
  return { action: 'restructure' };
}

function parseOutlineJson(text: string): Topic[] {
  let cleaned = stripCodeFence(text);

  // Try to find a JSON object in the text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.sections || !Array.isArray(parsed.sections)) return [];

    const topics: Topic[] = [];

    for (const section of parsed.sections) {
      const sectionName = section.name || '';
      if (!section.topics || !Array.isArray(section.topics)) continue;

      for (const item of section.topics) {
        if (item.type === 'group') {
          topics.push({
            title: item.title,
            level: '',
            slug: '',
            section: sectionName,
            isGroup: true,
          });
        } else {
          // Support both legacy brief and new description+task
          const description = item.description || item.brief || '';
          const task = item.task || item.brief || '';
          topics.push({
            title: item.title,
            level: item.level || '中级',
            slug: toSlug(item.title),
            section: sectionName,
            description,
            task,
          });
        }
      }
    }

    return topics;
  } catch {
    return [];
  }
}

async function collectFullResponse(
  client: LLMClient,
  messages: ChatMessage[],
  config: WikiCliConfig,
  stream: boolean,
  jsonMode?: boolean,
  tools?: ToolDefinition[],
  onProgress?: PageProgressFn
): Promise<string | null> {
  let accumulatedContent = '';
  let accumulatedReasoning = '';

  let iteration = 0;
  const maxToolIterations = 30;

  while (iteration < maxToolIterations) {
    iteration++;
    let hasToolCalls = false;
    let currentContent = '';
    let currentReasoning = '';
    let reasoningStarted = false;
    let contentStarted = false;
    const toolCallsMap = new Map<string, ToolCall>();

    const genTools = tools || getFilteredTools().filter(t =>
      !['list_wiki_pages', 'read_wiki', 'search_wiki', 'semantic_search'].includes(t.function.name)
    );

    if (stream) {
      const streamIter = client.chatStream(messages, genTools, jsonMode);

      try {
        for await (const chunk of streamIter) {
          if (chunk.type === 'reasoning' && chunk.reasoning_content) {
            currentReasoning += chunk.reasoning_content;
            if (!reasoningStarted) {
              reasoningStarted = true;
              process.stdout.write(chalk.dim.yellow('\nThinking: '));
              const snippet = chunk.reasoning_content.trim();
              if (snippet) onProgress?.('thinking', snippet.slice(0, 40));
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
              if (tc.id && !existing.id) existing.id = tc.id;
            } else {
              toolCallsMap.set(key, { ...tc });
            }
          } else if (chunk.type === 'error') {
            logError(chunk.error || 'Unknown error');
            return null;
          }
        }
      } catch (err: any) {
        logError(`Stream connection error: ${err.message}`);
        return null;
      }
    } else {
      try {
        const response = await client.chat(messages, genTools, jsonMode);

        currentContent = response.content || '';
        currentReasoning = response.reasoning_content || '';

        if (response.tool_calls && response.tool_calls.length > 0) {
          hasToolCalls = true;
          for (const tc of response.tool_calls) {
            const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
            toolCallsMap.set(key, { ...tc });
          }
        }
      } catch (err: any) {
        logError(`API error: ${err.message}`);
        return null;
      }
    }

    if (currentContent) {
      accumulatedContent += currentContent;
    }
    if (currentReasoning) {
      accumulatedReasoning += currentReasoning;
    }

    if (!hasToolCalls) {
      messages.push({
        role: 'assistant',
        content: currentContent || null,
        reasoning_content: currentReasoning || null,
      });
      if (stream) console.log();
      onProgress?.('done', '');
      return currentContent;
    }

    const toolCalls = [...toolCallsMap.values()];
    messages.push({
      role: 'assistant',
      content: currentContent || null,
      reasoning_content: currentReasoning || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      })),
    });

    if (stream) {
      console.log();
      logInfo(`Executing ${toolCalls.length} tool call(s)...`);
    }

    for (const tc of toolCalls) {
      let args: any;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      // Track page dependencies for --update mode
      if (_currentPageSlug && tc.function.name === 'read_file' && args.file_path) {
        const normalizedPath = relative(process.cwd(), resolve(args.file_path)).replace(/\\/g, '/');
        if (normalizedPath.startsWith('.wiki/') || normalizedPath === '.wiki') continue;
        if (!_pageDeps[_currentPageSlug]) _pageDeps[_currentPageSlug] = [];
        _pageDeps[_currentPageSlug].push({ file: normalizedPath, lines: [1, 999999] });
      }

      if (stream) logToolCall(tc.function.name, args);
      onProgress?.('tool', tc.function.name);
      const result = await executeToolCall(tc.function.name, args);
      if (stream) logToolResult(tc.function.name, result);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  if (accumulatedContent) {
    messages.push({ role: 'assistant', content: accumulatedContent, reasoning_content: accumulatedReasoning || null });
    return accumulatedContent;
  }

  return null;
}

interface PageGenOptions {
  parallel: boolean;
  concurrency: number;
  retryList?: Topic[];
  updateMode?: boolean;
  oldContentCache?: Record<string, string>;
  changedFilesInfo?: string;
}

async function generatePages(
  client: LLMClient,
  config: WikiCliConfig,
  workDir: string,
  allTopics: Topic[],
  options: PageGenOptions
): Promise<Topic[]> {
  const pageTopics = options.retryList || allTopics.filter(t => !t.isGroup);
  const failed: Topic[] = [];
  const updateMode = options.updateMode || false;
  const oldContentCache = options.oldContentCache || {};
  const changedFilesInfo = options.changedFilesInfo || '';

  // Create progress grid for parallel mode
  const grid = options.parallel && !options.retryList
    ? new ProgressGrid(pageTopics.map(t => t.title))
    : null;

  const availablePages = allTopics
    .filter(t => !t.isGroup && t.slug)
    .map(t => `- slug: ${t.slug}.md | 标题: ${t.title} | 简介: ${(t.description || t.task || '').slice(0, 80)}`)
    .join('\n');

  const osInfo = `${process.platform} ${process.arch}`;

  async function generateOne(topic: Topic, index: number, total: number): Promise<void> {
    const slug = topic.slug;
    const pagePath = join(TEMP_DIR, `${slug}.md`);
    if (!options.retryList && existsSync(pagePath)) {
      if (!options.parallel) {
        logInfo(`[${index + 1}/${total}] Skipping already generated: ${topic.title}`);
      }
      if (grid) grid.update(index, 'done', '');
      return;
    }

    if (!options.parallel) {
      logInfo(`[${index + 1}/${total}] Generating: ${topic.title} (${topic.level})`);
    }

    const pageSysVars = {
      workDir,
      os: osInfo,
      pageTitle: topic.title,
      audienceLevel: topic.level,
    };

    const oldContent = oldContentCache[slug] || '';
    const changeTrigger = updateMode && changedFilesInfo
      ? `以下文件发生了变更，可能与此页面相关：\n${changedFilesInfo}`
      : '';

    const pageUserVars = {
      workDir,
      pageTitle: topic.title,
      audienceLevel: topic.level,
      pageSlug: slug,
      projectSummary: '',
      lang: config.lang,
      availablePages,
      pageTask: topic.task || '',
      updateInstruction: updateMode ? '此页面需要更新。请基于旧版本修改，保留准确内容，只更新过时部分。新功能添加到相应位置。' : '',
      oldContent: oldContent || '',
      changeTrigger: changeTrigger || '',
    };

    const systemPrompt = await renderPrompt('page-system.md', pageSysVars);
    const userPrompt = await renderPrompt('page-user.md', pageUserVars);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    _currentPageSlug = slug;
    const fullContent = await collectFullResponse(
      client, messages, config, !options.parallel, undefined, undefined,
      grid ? (type, detail) => {
        if (type === 'thinking') grid.update(index, 'thinking', detail);
        else if (type === 'tool') grid.update(index, 'tool', detail);
        else if (type === 'done') grid.update(index, 'done', '');
      } : undefined
    );
    _currentPageSlug = null;

    if (fullContent) {
      await writeTextFile(pagePath, fullContent);
      _pageContent[slug] = fullContent;
      if (!grid) {
        if (options.parallel) {
          logSuccess(`[${index + 1}/${total}] Generated: ${topic.title}`);
        } else {
          logSuccess(`Generated: ${topic.title}`);
        }
      }
    } else {
      failed.push(topic);
      if (grid) {
        grid.update(index, 'failed', '');
      } else {
        logError(`Failed: ${topic.title}`);
      }
    }
  }

  if (options.parallel) {
    if (grid) grid.render();
    // Pre-mark already-generated (copied) pages as done so they don't show ⏳
    if (!options.retryList && grid) {
      for (let i = 0; i < pageTopics.length; i++) {
        if (existsSync(join(TEMP_DIR, `${pageTopics[i].slug}.md`))) {
          grid.update(i, 'done', '');
        }
      }
    }
    const total = pageTopics.length;
    await runConcurrent(
      pageTopics.map((topic, i) => () => generateOne(topic, i, total)),
      options.concurrency
    );
    if (grid) grid.finish();
  } else {
    const total = pageTopics.length;
    for (let i = 0; i < total; i++) {
      await generateOne(pageTopics[i], i, total);
    }
  }

  return failed;
}

async function runConcurrent(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
  const running = new Set<Promise<void>>();
  const queue = [...tasks];

  while (queue.length > 0 || running.size > 0) {
    while (running.size < concurrency && queue.length > 0) {
      const task = queue.shift()!;
      const p = task().finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

interface ResolveUpdateResult {
  topics: Topic[];
  updatePlan: UpdatePlan;
  pageDeps: PageDeps;
  pageContentCache: Record<string, string>;
  latestDir: string;
}

async function resolveUpdateTarget(workDir: string): Promise<ResolveUpdateResult | null> {
  const wikiDir = join(workDir, '.wiki');
  if (!existsSync(wikiDir)) {
    logWarning('没有找到现有 Wiki，回退到全量生成');
    return null;
  }
  const entries = readdirSync(wikiDir, { withFileTypes: true });
  const versions = entries
    .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
    .map(e => e.name)
    .sort()
    .reverse();
  if (versions.length === 0) {
    logWarning('没有找到 Wiki 版本，回退到全量生成');
    return null;
  }
  const latestDir = join(wikiDir, versions[0]);

  const metaPath = join(latestDir, '.meta.json');
  if (!existsSync(metaPath)) {
    logWarning('最新 Wiki 版本没有元数据，无法增量更新，回退到全量生成');
    return null;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  if (!meta.gitCommit) {
    logWarning('元数据中没有 git commit 信息，无法增量更新，回退到全量生成');
    return null;
  }

  const currentCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: workDir }).trim();
  if (meta.gitCommit === currentCommit) {
    logWarning('Wiki 已是最新，无需更新');
    process.exit(0);
  }

  try {
    execSync(`git cat-file -t ${meta.gitCommit}`, { encoding: 'utf-8', cwd: workDir, stdio: 'ignore' });
  } catch {
    logWarning('记录中的提交已不存在（rebase/gc），无法增量更新，回退到全量生成');
    return null;
  }

  const indexJsonPath = join(latestDir, 'index.json');
  if (!existsSync(indexJsonPath)) {
    logWarning('没有 index.json，无法增量更新，回退到全量生成');
    return null;
  }
  const outline = JSON.parse(readFileSync(indexJsonPath, 'utf-8'));
  const topics = outline.sections
    ? outline.sections.flatMap((s: any) => {
        const sectionName = s.name || '';
        return (s.topics || []).map((item: any) => {
          if (item.type === 'group') {
            return { title: item.title, level: '', slug: '', section: sectionName, isGroup: true } as Topic;
          }
          return {
            title: item.title,
            level: item.level || '中级',
            slug: toSlug(item.title),
            section: sectionName,
            description: item.description || item.brief || '',
            task: item.task || item.brief || '',
          } as Topic;
        });
      })
    : [];

  if (topics.length === 0) {
    logWarning('index.json 为空，无法增量更新，回退到全量生成');
    return null;
  }

  let pageDeps: PageDeps = {};
  const depsPath = join(latestDir, '.page-deps.json');
  if (existsSync(depsPath)) {
    pageDeps = JSON.parse(readFileSync(depsPath, 'utf-8'));
  } else {
    logWarning('没有页面依赖记录，增量更新将保守处理（标记所有页面）');
  }

  let pageContentCache: Record<string, string> = {};
  const contentPath = join(latestDir, '.page-content.json');
  if (existsSync(contentPath)) {
    pageContentCache = JSON.parse(readFileSync(contentPath, 'utf-8'));
  }

  logInfo(`最新 Wiki 版本: ${versions[0]} (commit: ${meta.gitCommit.slice(0, 8)})`);
  logInfo(`当前 HEAD: ${currentCommit.slice(0, 8)}`);

  return { topics, updatePlan: { action: 'update' }, pageDeps, pageContentCache, latestDir };
}

async function resolveAndRunUpdate(
  client: LLMClient,
  config: WikiCliConfig,
  workDir: string,
  opts: GenerateOptions
): Promise<{ topics: Topic[]; updatePlan: UpdatePlan } | null> {
  const resolved = await resolveUpdateTarget(workDir);
  if (!resolved) {
    logInfo('回退到全量生成');
    return null;
  }

  const { topics: oldTopics, pageDeps, pageContentCache, latestDir } = resolved;

  const meta = JSON.parse(readFileSync(join(latestDir, '.meta.json'), 'utf-8'));
  const oldCommit = meta.gitCommit;
  let changedFiles: ChangedFile[];
  try {
    changedFiles = getChangedFiles(oldCommit, workDir);
  } catch (err: any) {
    logWarning(`获取变更文件失败: ${err.message}，回退到全量生成`);
    return null;
  }

  if (changedFiles.length === 0) {
    logWarning('没有检测到文件变更');
    process.exit(0);
  }

  logInfo(`检测到 ${changedFiles.length} 个变更文件`);

  const modifiedFiles = changedFiles.filter(f => f.status === 'modified').map(f => f.path);
  const addedFiles = changedFiles.filter(f => f.status === 'added').map(f => f.path);
  const deletedFiles = changedFiles.filter(f => f.status === 'deleted').map(f => f.path);

  const affectedSlugs = [...getAffectedSlugs(pageDeps, changedFiles, workDir, oldCommit)];

  for (const cf of changedFiles) {
    if (cf.status === 'deleted' || cf.status === 'renamed') {
      for (const [slug, deps] of Object.entries(pageDeps)) {
        if (deps[cf.path] && !affectedSlugs.includes(slug)) {
          affectedSlugs.push(slug);
        }
      }
    }
  }

  logInfo(`文件变更影响 ${affectedSlugs.length} 个候选页面`);

  const changedFilesInfoLines = [...modifiedFiles, ...deletedFiles];
  if (addedFiles.length > 0) {
    changedFilesInfoLines.push('--- 新增文件 ---');
    changedFilesInfoLines.push(...addedFiles);
  }
  const changedFilesInfo = changedFilesInfoLines.join('\n');

  logInfo('Phase 1 Update: 分析变更影响...');
  const updatePlan = await updateAnalysis(
    client, config, workDir,
    JSON.parse(readFileSync(join(latestDir, 'index.json'), 'utf-8')),
    [...modifiedFiles, ...deletedFiles],
    affectedSlugs,
    pageDeps,
    pageContentCache,
    addedFiles
  );

  if (updatePlan.action === 'restructure') {
    logInfo('LLM 判定需要重新生成整个目录，回退到全量生成');
    return null;
  }

  const removeSet = new Set(updatePlan.remove || []);
  const addTopics = updatePlan.add || [];
  const updateSet = new Set(updatePlan.update || []);
  const renameList = updatePlan.rename || [];

  // rename implies: regenerate new slug + remove old slug
  const renameFromSet = new Set(renameList.map(r => r.from));
  for (const r of renameList) {
    removeSet.add(r.from);
    updateSet.add(r.to);
  }

  let finalUpdateSet: Set<string>;
  if (Object.keys(pageDeps).length === 0 && affectedSlugs.length > 0) {
    finalUpdateSet = new Set(affectedSlugs);
  } else {
    finalUpdateSet = updateSet;
  }

  logInfo(`Phase 2 Update: 更新 ${finalUpdateSet.size} 个页面, 新增 ${addTopics.length} 个, 移除 ${removeSet.size} 个${renameList.length > 0 ? `, 重命名 ${renameList.length} 个` : ''}`);
  let copiedCount = 0;

  // ── Copy unchanged pages ──
  for (const topic of oldTopics) {
    if (!topic.slug) continue;
    if (removeSet.has(topic.slug)) continue;
    if (finalUpdateSet.has(topic.slug)) continue;
    if (renameFromSet.has(topic.slug)) continue;

    const oldPath = join(latestDir, `${topic.slug}.md`);
    const newPath = join(TEMP_DIR, `${topic.slug}.md`);
    if (existsSync(oldPath)) {
      await ensureDir(TEMP_DIR);
      await copyFile(oldPath, newPath);
      copiedCount++;
    }
  }

  // ── Fix cross-references in unchanged pages ──
  if (renameList.length > 0) {
    let fixCount = 0;
    const renameMap = new Map(renameList.map(r => [r.from, r.to] as const));
    for (const topic of oldTopics) {
      if (!topic.slug) continue;
      if (removeSet.has(topic.slug) && !renameFromSet.has(topic.slug)) continue;
      if (finalUpdateSet.has(topic.slug)) continue;
      if (renameFromSet.has(topic.slug)) continue;
      const pagePath = join(TEMP_DIR, `${topic.slug}.md`);
      if (!existsSync(pagePath)) continue;
      let content = readFileSync(pagePath, 'utf-8');
      let changed = false;
      for (const [from, to] of renameMap) {
        for (const ref of [`](${from}.md)`, `](${from})`]) {
          const replacement = ref.endsWith('.md)') ? `](${to}.md)` : `](${to})`;
          if (content.includes(ref)) {
            content = content.split(ref).join(replacement);
            changed = true;
          }
        }
      }
      if (changed) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(pagePath, content, 'utf-8');
        fixCount++;
      }
    }
    if (fixCount > 0) logInfo(`已修复 ${fixCount} 个页面的交叉引用`);
  }

  // ── Build updated topics array with correct section placement ──
  const addBySection = new Map<string, Topic[]>();
  for (const t of addTopics) {
    const sec = t.section || '';
    if (!addBySection.has(sec)) addBySection.set(sec, []);
    addBySection.get(sec)!.push(t);
  }

  // Build rename target topic lookup
  const renameTargetByFrom = new Map(renameList.map(r => [r.from, r]));

  const updatedTopics: Topic[] = [];
  const addSectionsDone = new Set<string>();

  for (const topic of oldTopics) {
    if (removeSet.has(topic.slug) && !renameFromSet.has(topic.slug)) continue;

    const sec = topic.section || '';

    // Insert add topics for this section before the first topic of that section
    if (!addSectionsDone.has(sec) && addBySection.has(sec)) {
      addSectionsDone.add(sec);
      for (const add of addBySection.get(sec)!) {
        updatedTopics.push(add);
      }
    }

    // Replace renamed topics with renamed version
    if (renameFromSet.has(topic.slug)) {
      const r = renameTargetByFrom.get(topic.slug)!;
      updatedTopics.push({ ...topic, slug: r.to, title: r.title });
      continue;
    }

    updatedTopics.push(topic);
  }

  // Remaining add sections (entirely new sections not in old topics) go to end
  for (const [sec, topics] of addBySection) {
    if (!addSectionsDone.has(sec)) {
      if (sec) updatedTopics.push({ title: sec, level: '', slug: '', section: sec, isGroup: true });
      updatedTopics.push(...topics);
    }
  }

  return { topics: updatedTopics, updatePlan };
}

async function savePageMetadata(wikiDir: string): Promise<void> {
  const mergedDeps: PageDeps = {};
  for (const [slug, entries] of Object.entries(_pageDeps)) {
    const fileMap: Record<string, [number, number][]> = {};
    for (const entry of entries) {
      if (!fileMap[entry.file]) fileMap[entry.file] = [];
      let merged = false;
      for (const range of fileMap[entry.file]) {
        if (entry.lines[0] <= range[1] && entry.lines[1] >= range[0]) {
          range[0] = Math.min(range[0], entry.lines[0]);
          range[1] = Math.max(range[1], entry.lines[1]);
          merged = true;
          break;
        }
      }
      if (!merged) fileMap[entry.file].push([...entry.lines]);
    }
    mergedDeps[slug] = fileMap;
  }
  await writeTextFile(join(wikiDir, '.page-deps.json'), JSON.stringify(mergedDeps, null, 2));
  await writeTextFile(join(wikiDir, '.page-content.json'), JSON.stringify(_pageContent, null, 2));
}

async function generateIndex(wikiDir: string, topics: Topic[]): Promise<void> {
  const jsonOut: { sections: { name: string; topics: any[] }[] } = { sections: [] };
  const sections = [...new Set(topics.map(t => t.section).filter(Boolean))];

  for (const section of sections) {
    const sectionTopics = topics.filter(t => t.section === section);
    const items: any[] = [];

    for (const topic of sectionTopics) {
      if (topic.isGroup) {
        items.push({ type: 'group', title: topic.title });
      } else {
        const entry: any = { level: topic.level, title: topic.title };
        if (topic.description) entry.description = topic.description;
        if (topic.task) entry.task = topic.task;
        items.push(entry);
      }
    }

    jsonOut.sections.push({ name: section, topics: items });
  }

  await writeTextFile(join(wikiDir, 'index.json'), JSON.stringify(jsonOut, null, 2));
}
