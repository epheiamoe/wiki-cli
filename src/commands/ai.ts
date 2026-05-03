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
import chalk from 'chalk';
import { logInfo, logSuccess, logWarning, logError } from '../utils/progress.js';

export async function aiCommand(options: {
  question?: string;
  session?: string;
  listSessions?: boolean;
  deleteSession?: string;
}): Promise<void> {
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
  const wikiToolDefs = toolDefinitions.filter(t =>
    t.function.name === 'list_wiki_pages' || t.function.name === 'read_wiki'
  );
  const allToolDefs = hasWiki ? toolDefinitions : toolDefinitions.filter(t =>
    t.function.name !== 'list_wiki_pages' && t.function.name !== 'read_wiki'
  );

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
    await chatOnce(client, messages, allToolDefs, options.question);
    session.messages = messages.slice(1);
    session.summary = options.question.slice(0, 60);
    await saveSession(session);
    return;
  }

  console.log(chalk.cyan('\n💬 AI 问答模式（输入 /help 查看命令）\n'));

  if (restoredSession) {
    console.log(chalk.dim(`↳ 恢复会话 ${restoredSession.id}: ${restoredSession.summary}\n`));
    printSession(restoredSession);
    console.log('');
  }

  await interactiveLoop(client, messages, allToolDefs, session);
}

async function chatOnce(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  userInput: string
): Promise<string | null> {
  messages.push({ role: 'user', content: userInput });

  let accumulatedContent = '';
  let accumulatedReasoning = '';

  const maxIterations = 50;

  for (let iter = 0; iter < maxIterations; iter++) {
    let hasToolCalls = false;
    let currentContent = '';
    let currentReasoning = '';
    let reasoningStarted = false;
    let contentStarted = false;
    const toolCallsMap = new Map<string, ToolCall>();

    const streamIter = client.chatStream(messages, tools, false);

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

async function interactiveLoop(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  session: Session
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

  while (true) {
    const line = await rl.question(chalk.green('You > '));
    const input = line.trim();
    if (!input) continue;

    // Slash commands
    if (input.startsWith('/')) {
      const cmd = input.slice(1).toLowerCase();
      const parts = cmd.split(/\s+/);
      const command = parts[0];

      if (command === 'exit' || command === 'quit') {
        await saveSession(session);
        logSuccess(`会话已保存 (${session.id})`);
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
  /wiki           生成 Wiki
  /new            新会话
  /help           显示帮助`);
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

    // Normal chat
    const reasoningStarted = false;
    const contentStarted = false;
    await chatOnce(client, messages, tools, input);

    session.messages = messages.slice(1);
    session.summary = session.messages.find(m => m.role === 'user' && !m.content?.startsWith('/'))?.content?.slice(0, 60) || session.summary;
    await saveSession(session);
  }

  rl.close();
}
