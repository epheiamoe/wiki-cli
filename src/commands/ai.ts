import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readdir } from 'node:fs/promises';
import { loadConfig } from '../config/config-store.js';
import { LLMClient } from '../ai/llm-client.js';
import type { ChatMessage, ToolCall } from '../ai/llm-client.js';
import { renderPrompt } from '../ai/prompts.js';
import { toolDefinitions, executeToolCall } from '../ai/tools.js';
import {
  createSession, loadSession, saveSession, listSessions, deleteSession,
  printSession, showSessionsTable
} from '../ai/ai-session.js';
import type { Session } from '../ai/ai-session.js';
import { resolveWorkDir } from '../utils/workspace.js';
import chalk from 'chalk';
import { logInfo, logSuccess, logWarning, logError } from '../utils/progress.js';

export interface AiOptions {
  question?: string;
  dir?: string;
  url?: string;
  output?: string;
  branch?: string;
  depth?: number;
  temp?: boolean;
  session?: string;
  listSessions?: boolean;
  deleteSession?: string;
  answerOnly?: boolean;
}

export async function aiCommand(options: AiOptions = {}): Promise<void> {
  const { cleanup } = await resolveWorkDir({
    dir: options.dir,
    url: options.url,
    output: options.output,
    branch: options.branch,
    depth: options.depth,
    temp: options.temp,
  });

  const config = await loadConfig();
  if (!config) {
    logError('No configuration found. Run "wiki-cli config" first.');
    process.exit(1);
  }

  if (options.listSessions) {
    const sessions = await listSessions();
    console.log(chalk.bold('\n📋 保存的会话:'));
    showSessionsTable(sessions);
    return;
  }

  if (options.deleteSession) {
    const ok = await deleteSession(options.deleteSession);
    if (ok) logSuccess(`Session ${options.deleteSession} deleted.`);
    else logError(`Session ${options.deleteSession} not found.`);
    return;
  }

  const client = new LLMClient(config);
  const workDir = resolve(process.cwd());

  // Initialize tools with embedding config
  const { initTools } = await import('../ai/tools.js');
  if (config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey) {
    initTools({
      provider: config.embeddingProvider || '',
      model: config.embeddingModel,
      baseUrl: config.embeddingBaseUrl,
      apiKey: config.embeddingApiKey,
    });
  } else {
    initTools();
  }

  // Check for wiki
  let hasWiki = false;
  let wikiInfo = '';
  const wikiDir = join(workDir, '.wiki');
  if (existsSync(wikiDir)) {
    const entries = await readdir(wikiDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && e.name !== 'temp');
    if (dirs.length > 0) {
      hasWiki = true;
      wikiInfo = `该项目有 Wiki 文档，位于 .wiki/ 目录。共有 ${dirs.length} 个版本，最新版本：${dirs.map(e => e.name).sort().reverse()[0]}。`;
    }
  }

  if (!hasWiki) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(chalk.yellow('⚠ 该项目没有 Wiki 文档。要先生成吗？(Y/n) '));
    rl.close();
    if (answer.toLowerCase() !== 'n') {
      const { generateCommand } = await import('./generate.js');
      await generateCommand();
      hasWiki = true;
      wikiInfo = 'Wiki 已生成。';
    } else {
      wikiInfo = '该项目没有 Wiki 文档。';
    }
  }

  // Prepare tools list
  const hasEmbedding = !!(config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey);
  const skipTools = new Set(['list_wiki_pages', 'read_wiki', 'search_wiki']);
  if (!hasEmbedding) skipTools.add('semantic_search');
  if (!hasWiki) {
    skipTools.add('list_wiki_pages');
    skipTools.add('read_wiki');
    skipTools.add('search_wiki');
    skipTools.add('semantic_search');
  }
  const allToolDefs = toolDefinitions.filter(t => !skipTools.has(t.function.name));

  // Build system prompt
  const aiSysVars = {
    workDir,
    os: `${process.platform} ${process.arch}`,
    wikiInfo,
    wikiTools: hasWiki
      ? `### Wiki 工具（优先使用）
- list_wiki_pages：列出所有 Wiki 页面
- read_wiki：按 slug 读取 Wiki 页面`
      : '（该项目没有 Wiki）',
  };
  const systemPrompt = await renderPrompt('ai-system.md', aiSysVars);

  let session: Session;
  let messages: ChatMessage[];
  let restoredSession: Session | null = null;

  if (options.session) {
    const existing = await loadSession(options.session);
    if (!existing) {
      logError(`Session ${options.session} not found.`);
      return;
    }
    session = existing;
    restoredSession = existing;
    messages = [{ role: 'system', content: systemPrompt }, ...session.messages.slice(1)];
  } else {
    session = await createSession();
    messages = [{ role: 'system', content: systemPrompt }];
  }

  if (options.question) {
    if (options.answerOnly) {
      const result = await answerOnly(client, messages, allToolDefs, options.question);
      if (result) console.log(result);
    } else {
      await chatOnce(client, messages, allToolDefs, options.question);
    }
    session.messages = messages.slice(1);
    session.summary = options.question.slice(0, 60);
    await saveSession(session);
    if (cleanup) await cleanup();
    return;
  }

  console.log(chalk.cyan('\n💬 AI 问答模式（输入 /help 查看命令）\n'));

  if (restoredSession) {
    console.log(chalk.dim(`↳ 恢复会话 ${restoredSession.id}: ${restoredSession.summary}\n`));
    printSession(restoredSession);
    console.log('');
  }

  await interactiveLoop(client, messages, allToolDefs, session);
  if (cleanup) await cleanup();
}

async function chatOnce(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  userInput: string,
  isCancelled?: () => boolean
): Promise<string | null> {
  messages.push({ role: 'user', content: userInput });

  let accumulatedContent = '';
  let accumulatedReasoning = '';

  const maxIterations = 50;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (isCancelled?.()) {
      if (accumulatedContent) {
        messages.push({ role: 'assistant', content: accumulatedContent, reasoning_content: accumulatedReasoning || undefined });
      }
      return accumulatedContent || null;
    }
    let hasToolCalls = false;
    let currentContent = '';
    let currentReasoning = '';
    let reasoningStarted = false;
    let contentStarted = false;
    const toolCallsMap = new Map<string, ToolCall>();

    const streamIter = client.chatStream(messages, tools, false);

    try {
      for await (const chunk of streamIter) {
        if (isCancelled?.()) {
          if (currentContent) accumulatedContent += currentContent;
          if (currentReasoning) accumulatedReasoning += currentReasoning;
          messages.push({ role: 'assistant', content: currentContent || null, reasoning_content: currentReasoning || null });
          console.log(chalk.dim('\n⏹ (interrupted)'));
          return currentContent || null;
        }
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
          logError(chunk.error || 'Unknown error');
          return null;
        }
      }
    } catch (err: any) {
      logError(`Stream error: ${err.message}`);
      return null;
    }

    if (currentContent) accumulatedContent += currentContent;
    if (currentReasoning) accumulatedReasoning += currentReasoning;

    if (!hasToolCalls) {
      messages.push({ role: 'assistant', content: currentContent || null, reasoning_content: currentReasoning || null });
      console.log();
      return currentContent;
    }

    const toolCalls = [...toolCallsMap.values()];
    messages.push({
      role: 'assistant',
      content: currentContent || null,
      reasoning_content: currentReasoning || null,
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: tc.function })),
    });

    if (toolCalls.length > 0) {
      console.log();
    }

    for (const tc of toolCalls) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      logInfo(`Using tool: ${tc.function.name}`);
      const result = await executeToolCall(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
    }
  }

  logError('Max iterations reached.');
  return null;
}

async function answerOnly(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  userInput: string
): Promise<string | null> {
  messages.push({ role: 'user', content: userInput });

  const maxIterations = 50;

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasToolCalls = false;
    const toolCallsMap = new Map<string, ToolCall>();

    try {
      const response = await client.chat(messages, tools, false);

      const content = response.content || '';
      const toolCalls: ToolCall[] = (response.tool_calls || []).map((tc: any) => ({ ...tc }));

      if (toolCalls.length > 0) {
        hasToolCalls = true;
        for (const tc of toolCalls) {
          const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
          toolCallsMap.set(key, tc);
        }
      }

      if (!hasToolCalls) {
        messages.push({ role: 'assistant', content: content || null, reasoning_content: response.reasoning_content || null });
        return content || null;
      }

      const resolvedCalls = [...toolCallsMap.values()];
      messages.push({
        role: 'assistant',
        content: content || null,
        reasoning_content: response.reasoning_content || null,
        tool_calls: resolvedCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: tc.function })),
      });

      for (const tc of resolvedCalls) {
        let args: any;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const result = await executeToolCall(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
      }
    } catch (err: any) {
      logError(`API error: ${err.message}`);
      return null;
    }
  }

  logError('Max iterations reached.');
  return null;
}

async function interactiveLoop(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  session: Session
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

  while (true) {
    let line: string;
    try {
      line = await rl.question(chalk.green('You > '));
    } catch {
      await exitSession(session);
      break;
    }
    const input = line.trim();
    if (!input) continue;

    // Slash commands
    if (input.startsWith('/')) {
      const cmd = input.slice(1).toLowerCase();
      const parts = cmd.split(/\s+/);
      const command = parts[0];

      if (command === 'exit' || command === 'quit') {
        await exitSession(session);
        break;
      }

      if (command === 'help') {
        console.log(`
  ${chalk.bold('斜杠命令')}
  /exit, /quit    退出并保存会话
  /save           手动保存
  /clear          清屏
  /session        显示当前会话 ID
  /sessions       列出所有会话
  /switch <id>    切换会话
  /undo           撤回上一条对话
  /wiki           生成 Wiki
  /new            新会话
  /help           显示帮助`);
        continue;
      }

      if (command === 'undo') {
        let userIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') { userIdx = i; break; }
        }
        if (userIdx > 0) {
          messages.splice(userIdx);
          logSuccess('已撤销上一条对话');
        } else {
          logWarning('没有可撤销的消息');
        }
        continue;
      }

      if (command === 'save') {
        session.messages = messages.slice(1);
        await saveSession(session);
        logSuccess(`会话已保存 (${session.id})`);
        continue;
      }

      if (command === 'clear') {
        console.clear();
        continue;
      }

      if (command === 'session') {
        console.log(`  当前会话: ${chalk.cyan(session.id)} (${session.summary})`);
        continue;
      }

      if (command === 'sessions') {
        const all = await listSessions();
        showSessionsTable(all);
        continue;
      }

      if (command === 'switch' && parts[1]) {
        const existing = await loadSession(parts[1]);
        if (!existing) {
          logError(`Session ${parts[1]} not found.`);
          continue;
        }
        await saveSession(session);
        session = existing;
        messages = [{ role: 'system', content: messages[0].content }, ...session.messages.slice(1)];
        logSuccess(`切换到会话 ${session.id} (${session.summary})`);
        continue;
      }

      if (command === 'new') {
        await saveSession(session);
        session = await createSession();
        messages = [{ role: 'system', content: messages[0].content }];
        logSuccess(`新会话已创建 (${session.id})`);
        continue;
      }

      if (command === 'wiki') {
        const { generateCommand } = await import('./generate.js');
        await generateCommand();
        continue;
      }

      logWarning(`未知命令: /${command}。输入 /help 查看帮助。`);
      continue;
    }

    // Normal chat with Ctrl+C interrupt support
    let streamingCancelled = false;
    const sigHandler = () => { streamingCancelled = true; };
    process.on('SIGINT', sigHandler);
    try {
      await chatOnce(client, messages, tools, input, () => streamingCancelled);
    } finally {
      process.removeListener('SIGINT', sigHandler);
    }

    session.messages = messages.slice(1);
    session.summary = session.messages.find(m => m.role === 'user' && !m.content?.startsWith('/'))?.content?.slice(0, 60) || session.summary;
    await saveSession(session);
  }

  rl.close();
}

async function exitSession(session: Session): Promise<void> {
  await saveSession(session);
  logSuccess(`会话已保存 (${session.id})`);
  console.log(chalk.dim(`to continue, run: wiki-cli ai --session ${session.id}`));
}
