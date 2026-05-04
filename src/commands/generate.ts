import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import inquirer from 'inquirer';
import { loadConfig } from '../config/config-store.js';
import { LLMClient, stripCodeFence } from '../ai/llm-client.js';
import type { ChatMessage, ToolCall } from '../ai/llm-client.js';
import { renderPrompt } from '../ai/prompts.js';
import { toolDefinitions, executeToolCall } from '../ai/tools.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { ensureDir, writeTextFile, moveDir, getTimestamp, toSlug, removeDir } from '../utils/file.js';
import { resolveWorkDir } from '../utils/workspace.js';
import chalk from 'chalk';
import { logInfo, logSuccess, logWarning, logError, logToolCall, logToolResult } from '../utils/progress.js';

const TEMP_DIR = '.wiki/temp';

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

  const workDir = resolve(process.cwd());

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

  logInfo('Phase 1: Analyzing repository and generating outline...');
  const topics = await generateOutline(client, config, workDir);
  if (topics.length === 0) {
    logError('Failed to generate outline. No topics found.');
    process.exit(1);
  }
  logSuccess(`Generated ${topics.length} topics.`);

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

  logInfo('Phase 2: Generating Wiki pages...');
  let failed = await generatePages(client, config, workDir, topics, { parallel, concurrency });

  let retriesLeft = opts.retry ?? 0;
  while (failed.length > 0 && retriesLeft > 0) {
    logWarning(`${failed.length} page(s) failed. Retrying (${retriesLeft} left)...`);
    const retryResult = await generatePages(client, config, workDir, topics, { parallel, concurrency, retryList: [...failed] });
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
      const r = await generatePages(client, config, workDir, topics, { parallel, concurrency, retryList: [...failed] });
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

  if (opts.browse) {
    logInfo('Starting browse server...');
    const { browseCommand } = await import('./browse.js');
    await browseCommand({ path: absPath });
    return;
  }

  if (opts.silent) {
    console.log(`Result: ${topics.filter(t => !t.isGroup).length} pages, ${failed.length} failed`);
    if (cleanup) await cleanup();
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

  if (cleanup) await cleanup();
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
  jsonMode?: boolean
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

    if (stream) {
      const streamIter = client.chatStream(messages, toolDefinitions, jsonMode);

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
        const response = await client.chat(messages, toolDefinitions, jsonMode);

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

      if (stream) logToolCall(tc.function.name, args);
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
        logInfo(`[${index}/${total}] Skipping already generated: ${topic.title}`);
      }
      return;
    }

    if (!options.parallel) {
      logInfo(`[${index}/${total}] Generating: ${topic.title} (${topic.level})`);
    }

    const pageSysVars = {
      workDir,
      os: osInfo,
      pageTitle: topic.title,
      audienceLevel: topic.level,
    };
    const pageUserVars = {
      workDir,
      pageTitle: topic.title,
      audienceLevel: topic.level,
      pageSlug: slug,
      projectSummary: '',
      lang: config.lang,
      availablePages,
      pageTask: topic.task || '',
    };

    const systemPrompt = await renderPrompt('page-system.md', pageSysVars);
    const userPrompt = await renderPrompt('page-user.md', pageUserVars);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const fullContent = await collectFullResponse(client, messages, config, !options.parallel);

    if (fullContent) {
      await writeTextFile(pagePath, fullContent);
      if (options.parallel) {
        logSuccess(`[${index}/${total}] Generated: ${topic.title}`);
      } else {
        logSuccess(`Generated: ${topic.title}`);
      }
    } else {
      failed.push(topic);
      logError(`Failed: ${topic.title}`);
    }
  }

  if (options.parallel) {
    const total = pageTopics.length;
    await runConcurrent(
      pageTopics.map((topic, i) => () => generateOne(topic, i + 1, total)),
      options.concurrency
    );
  } else {
    const total = pageTopics.length;
    for (let i = 0; i < total; i++) {
      await generateOne(pageTopics[i], i + 1, total);
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
