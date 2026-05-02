import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import inquirer from 'inquirer';
import { loadConfig } from '../config/config-store.js';
import { LLMClient } from '../ai/llm-client.js';
import type { ChatMessage, ToolCall } from '../ai/llm-client.js';
import { renderPrompt } from '../ai/prompts.js';
import { toolDefinitions, executeToolCall } from '../ai/tools.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { ensureDir, writeTextFile, moveDir, getTimestamp, toSlug, removeDir } from '../utils/file.js';
import chalk from 'chalk';
import { logInfo, logSuccess, logWarning, logError, logToolCall, logToolResult } from '../utils/progress.js';

const TEMP_DIR = '.wiki/temp';

interface Topic {
  title: string;
  level: string;
  slug: string;
  section: string;
  isGroup?: boolean;
}

export async function generateCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    logError('No configuration found. Run "wiki-cli config" first.');
    process.exit(1);
  }

  const workDir = resolve(process.cwd());

  if (existsSync(TEMP_DIR)) {
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

    if (action === 'fresh') {
      await removeDir(TEMP_DIR);
    }
  }

  if (!existsSync(TEMP_DIR)) {
    await ensureDir(TEMP_DIR);
  }

  const client = new LLMClient(config);

  // Phase 1: Generate outline
  logInfo('Phase 1: Analyzing repository and generating outline...');
  const topics = await generateOutline(client, config, workDir);

  if (topics.length === 0) {
    logError('Failed to generate outline. No topics found.');
    process.exit(1);
  }

  logSuccess(`Generated ${topics.length} topics.`);

  // Phase 2: Generate pages
  logInfo('Phase 2: Generating Wiki pages...');
  let failed = await generatePages(client, config, workDir, topics);

  while (failed.length > 0) {
    logWarning(`${failed.length} page(s) failed to generate.`);
    const { retry } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retry',
        message: 'Retry failed pages?',
        default: true,
      },
    ]);

    if (!retry) break;

    logInfo(`Retrying ${failed.length} page(s)...`);
    failed = await generatePages(client, config, workDir, topics, failed);
  }

  if (failed.length > 0) {
    logWarning(`${failed.length} page(s) were not generated successfully.`);
  }

  // Finalize: Move temp to timestamped directory
  const timestamp = getTimestamp();
  const finalDir = join('.wiki', timestamp);
  await moveDir(TEMP_DIR, finalDir);
  logSuccess(`Wiki generated at ${finalDir}`);

  // Generate index
  await generateIndex(finalDir, topics);
  logSuccess('Index file generated.');
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

  let finalContent = '';
  const maxIterations = 25;

  for (let i = 0; i < maxIterations; i++) {
    logInfo(`LLM round ${i + 1} (streaming below)...`);

    try {
      const fullContent = await collectFullResponse(client, messages, config, 'outline');

      if (!fullContent) {
        logError('No response from LLM');
        break;
      }

      finalContent = fullContent;

      if (fullContent.includes('<section>')) {
        logSuccess('Outline generated successfully.');

        const topics = parseOutlineTopics(fullContent, config.lang);

        await writeTextFile(join(TEMP_DIR, '_outline.xml'), fullContent);
        return topics;
      }

      const response: ChatMessage = { role: 'assistant', content: fullContent };
      logSuccess(`Got ${fullContent.length} chars of response.`);
      messages.push(response);

    } catch (err: any) {
      logError(`Error: ${err.message}`);
      break;
    }
  }

  // Try to parse whatever we have
  if (finalContent && finalContent.includes('<section>')) {
    return parseOutlineTopics(finalContent, config.lang);
  }

  return [];
}

async function collectFullResponse(
  client: LLMClient,
  messages: ChatMessage[],
  config: WikiCliConfig,
  phase: string
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

    const streamIter = client.chatStream(messages, toolDefinitions);

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
      console.log();
      return currentContent;
    }

    // Process tool calls
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

    console.log();
    logInfo(`Executing ${toolCalls.length} tool call(s)...`);

    for (const tc of toolCalls) {
      let args: any;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }

      logToolCall(tc.function.name, args);
      const result = await executeToolCall(tc.function.name, args);
      logToolResult(tc.function.name, result);

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

function parseOutlineTopics(xmlContent: string, lang: string): Topic[] {
  const topics: Topic[] = [];
  let currentSection = '';
  let pendingSection = false;

  const lines = xmlContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    const sectionMatch = trimmed.match(/^<section>\s*([^<]*)/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      if (name) {
        currentSection = name;
        pendingSection = false;
      } else {
        pendingSection = true;
      }
      continue;
    }

    if (pendingSection) {
      currentSection = trimmed;
      pendingSection = false;
      continue;
    }

    if (trimmed.startsWith('</section>')) {
      currentSection = '';
      pendingSection = false;
      continue;
    }

    const topicMatch = trimmed.match(/<topic\s+level="([^"]*)">([^<]*)<\/topic>/);
    if (topicMatch) {
      const title = topicMatch[2].trim();
      const level = topicMatch[1].trim();
      topics.push({
        title,
        level,
        slug: toSlug(title),
        section: currentSection,
      });
      continue;
    }

    const groupMatch = trimmed.match(/<group>([^<]*)<\/group>/);
    if (groupMatch) {
      const title = groupMatch[1].trim();
      topics.push({
        title,
        level: '',
        slug: '',
        section: currentSection,
        isGroup: true,
      });
    }
  }

  return topics;
}

async function generatePages(
  client: LLMClient,
  config: WikiCliConfig,
  workDir: string,
  topics: Topic[],
  retryList?: Topic[]
): Promise<Topic[]> {
  const pageTopics = retryList || topics.filter(t => !t.isGroup);
  const failed: Topic[] = [];

  for (let i = 0; i < pageTopics.length; i++) {
    const topic = pageTopics[i];
    const slug = topic.slug;

    const pagePath = join(TEMP_DIR, `${slug}.md`);
    if (!retryList && existsSync(pagePath)) {
      logInfo(`[${i + 1}/${pageTopics.length}] Skipping already generated: ${topic.title}`);
      continue;
    }

    logInfo(`[${i + 1}/${pageTopics.length}] Generating: ${topic.title} (${topic.level})`);

    const osInfo = `${process.platform} ${process.arch}`;
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
    };

    const systemPrompt = await renderPrompt('page-system.md', pageSysVars);
    const userPrompt = await renderPrompt('page-user.md', pageUserVars);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const fullContent = await collectFullResponse(client, messages, config, 'page');

    if (fullContent) {
      await writeTextFile(pagePath, fullContent);
      logSuccess(`Generated: ${topic.title}`);
    } else {
      failed.push(topic);
      logError(`Failed to generate: ${topic.title}`);
    }
  }

  return failed;
}

async function generateIndex(wikiDir: string, topics: Topic[]): Promise<void> {
  const lines: string[] = ['# Wiki Documentation\n'];

  const sections = [...new Set(topics.map(t => t.section).filter(Boolean))];

  for (const section of sections) {
    lines.push(`<section>\n${section}`);
    const sectionTopics = topics.filter(t => t.section === section);

    for (const topic of sectionTopics) {
      if (topic.isGroup) {
        lines.push(`<group>${topic.title}</group>`);
      } else {
        lines.push(`<topic level="${topic.level}">${topic.title}</topic>`);
      }
    }

    lines.push('</section>\n');
  }

  await writeTextFile(join(wikiDir, 'index.md'), lines.join('\n'));
}
