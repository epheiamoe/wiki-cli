import { readFile, readdir } from 'node:fs/promises';
import { join, extname, resolve, sep, normalize, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { logInfo, logSuccess, logError } from '../utils/progress.js';
import { stripCodeFence } from '../ai/llm-client.js';
import { LLMClient } from '../ai/llm-client.js';
import type { ChatMessage, ToolCall } from '../ai/llm-client.js';
import { findExistingRepoDir, defaultRepoDir } from '../utils/workspace.js';
import { loadConfig } from '../config/config-store.js';
import { initTools, getFilteredTools, executeToolCall } from '../ai/tools.js';
import { createSession, loadSession, saveSession } from '../ai/ai-session.js';
import { renderPrompt } from '../ai/prompts.js';

export interface BrowseOptions {
  path?: string;
  url?: string;
}

export async function browseCommand(options?: BrowseOptions): Promise<void> {
  let wikiDir: string;

  if (options?.path) {
    wikiDir = resolve(options.path);
    if (existsSync(wikiDir) && basename(dirname(wikiDir)) === '.wiki') {
      wikiDir = dirname(wikiDir);
    }
    if (existsSync(wikiDir) && basename(wikiDir) !== '.wiki') {
      const nested = join(wikiDir, '.wiki');
      if (existsSync(nested)) wikiDir = nested;
    }
  } else if (options?.url) {
    const repoDir = findExistingRepoDir(options.url) || defaultRepoDir(options.url);
    wikiDir = join(repoDir, '.wiki');
  } else {
    wikiDir = join(resolve(process.cwd()), '.wiki');
  }

  if (!existsSync(wikiDir)) {
    logError(`Wiki directory not found: ${wikiDir}`);
    logError('Run "wiki-cli generate" first or specify correct path.');
    process.exit(1);
  }

  const projectRoot = resolve(wikiDir, '..');

  const entries = await readdir(wikiDir, { withFileTypes: true });
  const timestamps = entries
    .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
    .map(e => e.name)
    .sort()
    .reverse();

  if (timestamps.length === 0) {
    logError('No generated Wiki found. Run "wiki-cli generate" first.');
    process.exit(1);
  }

  const latest = timestamps[0];
  logInfo(`Browsing Wiki: ${latest}`);
  const allVersions = timestamps;

  // Chat: load config for AI panel
  const config = await loadConfig();
  let chatClient: LLMClient | null = null;
  let chatTools: ReturnType<typeof getFilteredTools> = [];
  let chatSystemPrompt = '';

  if (config) {
    const webConfig = !config.webFetchDisabled
      ? { baseUrl: config.webFetchBaseUrl || 'https://r.jina.ai', apiKey: config.webFetchApiKey }
      : { disabled: true as const, baseUrl: '', apiKey: '' };

    if (config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey) {
      initTools(
        { provider: config.embeddingProvider || '', model: config.embeddingModel, baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey },
        webConfig,
      );
    } else {
      initTools(undefined, webConfig);
    }

    chatClient = new LLMClient(config);
    chatTools = getFilteredTools();
    if (!(config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey)) {
      chatTools = chatTools.filter(t => t.function.name !== 'semantic_search');
    }

    const wikiInfo = `该项目有 Wiki 文档，位于 ${wikiDir}。共有 ${timestamps.length} 个版本。`;
    chatSystemPrompt = await renderPrompt('ai-system.md', {
      workDir: projectRoot,
      os: `${process.platform} ${process.arch}`,
      wikiInfo,
      wikiTools: `### Wiki 工具
- list_wiki_pages：列出所有 Wiki 页面
- read_wiki：按 slug 读取 Wiki 页面`,
    });
  }

  const port = await findFreePort(3000);

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  function getVersionFromUrl(reqUrl: string): string {
    try {
      const u = new URL(reqUrl, `http://localhost:${port}`);
      return u.searchParams.get('version') || latest;
    } catch {
      return latest;
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const pathname = url.pathname;
      const version = url.searchParams.get('version') || latest;
      const wikiPath = join(wikiDir, version);

      if (pathname === '/') {
        const sidebarItems = await loadSidebar(wikiPath);
        const firstPage = sidebarItems.length > 0 ? join(wikiPath, `${sidebarItems[0].slug}.md`) : null;
        await serveHtml(res, wikiPath, sidebarItems, firstPage, allVersions, version, !!chatClient);
        return;
      }

      if (pathname === '/api/versions') {
        const list = allVersions.map(v => ({
          ts: v,
          current: v === version,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(list));
        return;
      }

      // Chat SSE endpoint
      if (pathname === '/api/chat/' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session');
        if (sessionId) {
          const { loadSession } = await import('../ai/ai-session.js');
          const session = await loadSession(sessionId);
          if (session) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(session));
          } else {
            res.writeHead(404);
            res.end('Session not found');
          }
        } else {
          res.writeHead(400);
          res.end('Missing session parameter');
        }
        return;
      }

      if (pathname === '/api/chat/' && req.method === 'POST' && chatClient) {
        let body = '';
        req.on('data', (chunk: string) => body += chunk);
        req.on('end', async () => {
          try {
            const { message, sessionId } = JSON.parse(body);
            if (!message) { res.writeHead(400); res.end('Missing message'); return; }

            let session = sessionId ? await loadSession(sessionId) : null;
            if (!session) session = await createSession();

            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            const sse = (data: any) => res.write(`data: ${JSON.stringify(data)}\n\n`);

            const allMessages: ChatMessage[] = [
              { role: 'system', content: chatSystemPrompt },
              ...(session.messages || []),
              { role: 'user', content: message },
            ];

            const maxIterations = 30;

            for (let iter = 0; iter < maxIterations; iter++) {
              const streamIter = chatClient.chatStream(allMessages, chatTools, false);
              let currentContent = '';
              let currentReasoning = '';
              let hasToolCalls = false;
              const toolCallsMap = new Map<string, ToolCall>();

              try {
                for await (const chunk of streamIter) {
                  if (chunk.type === 'reasoning' && chunk.reasoning_content) {
                    currentReasoning += chunk.reasoning_content;
                    sse({ type: 'reasoning', text: chunk.reasoning_content });
                  } else if (chunk.type === 'content') {
                    currentContent += chunk.content ?? '';
                    sse({ type: 'content', text: chunk.content ?? '' });
                  } else if (chunk.type === 'tool_call' && chunk.tool_call) {
                    hasToolCalls = true;
                    const tc = chunk.tool_call;
                    const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
                    const existing = toolCallsMap.get(key);
                    if (existing) {
                      existing.function.arguments += tc.function.arguments;
                    } else {
                      toolCallsMap.set(key, { ...tc });
                    }
                  } else if (chunk.type === 'error') {
                    sse({ type: 'error', text: chunk.error || 'Unknown error' });
                    res.end();
                    return;
                  }
                }
              } catch (err: any) {
                sse({ type: 'error', text: err.message });
                res.end();
                return;
              }

              if (!hasToolCalls) {
                allMessages.push({ role: 'assistant', content: currentContent || null, reasoning_content: currentReasoning || null });
                break;
              }

              const calls = [...toolCallsMap.values()];
              allMessages.push({
                role: 'assistant',
                content: currentContent || null,
                reasoning_content: currentReasoning || null,
                tool_calls: calls.map(tc => ({ id: tc.id, type: 'function' as const, function: tc.function })),
              });

              for (const tc of calls) {
                sse({ type: 'tool_call', name: tc.function.name, args: tc.function.arguments });
                let args: any;
                try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                const result = await executeToolCall(tc.function.name, args);
                const summary = typeof result.data === 'string' ? result.data.slice(0, 120) : JSON.stringify(result.data).slice(0, 120);
                sse({ type: 'tool_result', name: tc.function.name, summary });
                allMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
              }
            }

            session.messages = allMessages.slice(1);
            session.summary = message.slice(0, 60);
            await saveSession(session);

            sse({ type: 'done', sessionId: session.id });
          } catch (err: any) {
            if (!res.headersSent) { res.writeHead(500); res.end(err.message); return; }
            res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
          }
          res.end();
        });
        return;
      }

      if (pathname.startsWith('/api/page/')) {
        const slug = decodeURIComponent(pathname.slice(10).replace(/\.md$/, ''));
        const mdPath = join(wikiPath, `${slug}.md`);
        if (existsSync(mdPath)) {
          const content = await readFile(mdPath, 'utf-8');
          const html = await marked.parse(content);
          const fixed = fixContentReferences(html);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fixed);
        } else {
          res.writeHead(404);
          res.end('Page not found');
        }
        return;
      }

      if (pathname.startsWith('/api/source/')) {
        const rawPath = decodeURIComponent(pathname.slice(12));
        const safePath = sanitizePath(rawPath, projectRoot);
        if (!safePath) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const fullPath = join(projectRoot, safePath);
        if (!existsSync(fullPath)) {
          res.writeHead(404);
          res.end('Source file not found');
          return;
        }
        const content = await readFile(fullPath, 'utf-8');
        const ext = extname(fullPath);
        const langName = extToLang(ext);
        const fileName = pathname.slice(12);

        const rawLines = content.split('\n');
        const lineHtml = rawLines.map((raw, i) => {
          const num = i + 1;
          let codeHtml: string;
          if (raw.length > 0) {
            const result = hljs.highlight(raw, { language: langName, ignoreIllegals: true });
            codeHtml = result.value;
          } else {
            codeHtml = '&nbsp;';
          }
          return `<div class="line" data-line="${num}"><span class="line-num">${num}</span><span class="line-code">${codeHtml}</span></div>`;
        }).join('\n');

        const sourceHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(fileName)} — 源码</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.header { display: flex; align-items: center; gap: 12px; padding: 12px 24px; background: #161b22; border-bottom: 1px solid #30363d; position: sticky; top: 0; z-index: 10; }
.header a { color: #58a6ff; text-decoration: none; font-size: 14px; cursor: pointer; }
.header a:hover { text-decoration: underline; }
.header span { color: #8b949e; font-size: 13px; }
.header .path { color: #f0f6fc; font-size: 14px; font-family: 'JetBrains Mono', 'Fira Code', monospace; }
pre { padding: 16px 0; overflow-x: auto; margin: 0; font-size: 13px; line-height: 1; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; }
.line { display: flex; padding: 0 24px; }
.line:hover { background: rgba(255,255,255,0.03); }
.line-num { width: 56px; text-align: right; padding-right: 16px; color: #484f58; user-select: none; flex-shrink: 0; font-size: 12px; line-height: inherit; }
.line-code { flex: 1; line-height: inherit; }
.line.hl { background: rgba(88,166,255,0.08); border-left: 2px solid #58a6ff; }
.line.hl .line-num { color: #58a6ff; font-weight: 600; }
.line.hl .line-num { color: #58a6ff; }
</style>
</head>
<body>
<div class="header">
  <a onclick="window.close(); return false;" href="#">← Wiki</a>
  <span>|</span>
  <span class="path">${escapeHtml(fileName)}</span>
  <span style="margin-left:auto;background:#1c2333;padding:2px 10px;border-radius:4px;font-size:12px;color:#8b949e">${langName}</span>
</div>
<pre>${lineHtml}</pre>
<script>
document.addEventListener('DOMContentLoaded', function(){
  var h = location.hash.slice(1);
  if (!h) return;
  var m = h.match(/^L(\d+)(?:-L(\d+))?$/);
  if (!m) return;
  var s = parseInt(m[1], 10), e = m[2] ? parseInt(m[2], 10) : s;
  var target;
  for (var i = Math.max(1, s); i <= e; i++) {
    var el = document.querySelector('[data-line="' + i + '"]');
    if (el) { el.classList.add('hl'); if (!target) target = el; }
  }
  if (target) target.scrollIntoView({ block: 'center' });
});
</script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(sourceHtml);
        return;
      }

      if (pathname.endsWith('.md') && !pathname.startsWith('/api/')) {
        const slug = pathname.replace(/\.md$/, '').replace(/^\//, '');
        res.writeHead(302, { Location: '/api/page/' + encodeURIComponent(slug) + '.md' + '?version=' + encodeURIComponent(version) });
        res.end();
        return;
      }

      const filePath = join(wikiPath, pathname);
      if (existsSync(filePath) && !filePath.endsWith('.md')) {
        const ext = extname(filePath);
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const content = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err: any) {
      res.writeHead(500);
      res.end(err.message);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    logSuccess(`Wiki server started at ${url}`);

    const start =
      process.platform === 'win32' ? 'start' :
      process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execSync(`${start} ${url}`, { stdio: 'ignore' });
    } catch {
      logInfo(`Please open ${url} in your browser.`);
    }
  });
}

function dirname(p: string): string {
  const i = p.replace(/[\\/]+$/, '').lastIndexOf(sep);
  return i === -1 ? p : p.slice(0, i);
}

interface SidebarItem {
  title: string;
  slug: string;
  level: string;
}

async function loadSidebar(wikiPath: string): Promise<SidebarItem[]> {
  const jsonPath = join(wikiPath, 'index.json');
  if (existsSync(jsonPath)) {
    try {
      const content = await readFile(jsonPath, 'utf-8');
      return parseIndexJson(content);
    } catch {
      // fall through
    }
  }

  const mdPath = join(wikiPath, 'index.md');
  if (existsSync(mdPath)) {
    try {
      const content = await readFile(mdPath, 'utf-8');
      return parseIndexXml(content);
    } catch {
      // ignore
    }
  }

  return [];
}

function parseIndexJson(content: string): SidebarItem[] {
  const cleaned = stripCodeFence(content);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return []; }

  if (!parsed.sections || !Array.isArray(parsed.sections)) return [];

  const items: SidebarItem[] = [];
  for (const section of parsed.sections) {
    if (!section.topics || !Array.isArray(section.topics)) continue;
    for (const topic of section.topics) {
      if (topic.type === 'group') {
        items.push({ title: topic.title, slug: '', level: 'group' });
      } else if (topic.title) {
        items.push({ title: topic.title, slug: slugify(topic.title), level: topic.level || '中级' });
      }
    }
  }
  return items;
}

function parseIndexXml(content: string): SidebarItem[] {
  const items: SidebarItem[] = [];
  const lines = content.split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('<section>')) { inSection = true; continue; }
    if (trimmed.startsWith('</section>')) { inSection = false; continue; }
    if (!inSection) continue;
    const topicMatch = trimmed.match(/<topic\s+level="([^"]*)"[^>]*>([^<]*)<\/topic>/);
    if (topicMatch) {
      items.push({ title: topicMatch[2], slug: slugify(topicMatch[2]), level: topicMatch[1] });
      continue;
    }
    const groupMatch = trimmed.match(/<group>([^<]*)<\/group>/);
    if (groupMatch) {
      items.push({ title: groupMatch[1], slug: '', level: 'group' });
    }
  }
  return items;
}

function sanitizePath(rawPath: string, root: string): string | null {
  const cleaned = rawPath.replace(/^[/\\]+/, '');
  const normalized = normalize(cleaned).replace(/^(\.\.(\/|\\))+/g, '');
  const resolved = resolve(root, normalized);
  if (!resolved.startsWith(root + sep) && resolved !== root) return null;
  return normalized;
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.js': 'javascript', '.json': 'json',
    '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
    '.html': 'html', '.css': 'css', '.sh': 'bash', '.bash': 'bash',
  };
  return map[ext] || 'plaintext';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fixContentReferences(html: string): string {
  return html.replace(/\[来源：([^\]]+)\]/g, '<a href="/api/source/$1" target="_blank" class="source-ref">[来源]</a>');
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function buildSidebarHtml(items: SidebarItem[]): string {
  const parts = items.map(item => {
    if (item.level === 'group') return `<li class="nav-group">${item.title}</li>`;
    const badge = item.level === '初学' ? '🟢' : item.level === '中级' ? '🟡' : '🔴';
    return `<li><a href="#" onclick="loadPage('${encodeURIComponent(item.slug)}')">${badge} ${item.title}</a></li>`;
  });
  return parts.join('\n');
}

function buildVersionsHtml(versions: string[], current: string): string {
  return versions.map(v =>
    `<a href="#" class="${v === current ? 'current' : ''}" onclick="switchVersion('${v}')">${v}</a>`
  ).join('');
}

async function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(preferred, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => resolve(preferred));
      }
    });
    srv.on('error', () => resolve(findFreePort(preferred + 1)));
  });
}

async function serveHtml(
  res: ServerResponse,
  wikiPath: string,
  sidebarItems: SidebarItem[],
  firstPage: string | null,
  allVersions: string[],
  currentVersion: string,
  chatEnabled: boolean
): Promise<void> {
  let firstContent = '';
  if (firstPage && existsSync(firstPage)) {
    const md = await readFile(firstPage, 'utf-8');
    firstContent = fixContentReferences(await marked.parse(md));
  }

  const sidebarHtml = buildSidebarHtml(sidebarItems);
  const versionsHtml = buildVersionsHtml(allVersions, currentVersion);
  const slugs = sidebarItems.filter(i => i.slug).map(i => i.slug);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wiki</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; height: 100vh; background: #0d1117; color: #c9d1d9; justify-content: center; }
.wrapper { display: flex; width: 100%; max-width: 1280px; }
.sidebar { width: 280px; background: #161b22; border-right: 1px solid #30363d; padding: 20px; overflow-y: auto; flex-shrink: 0; display: flex; flex-direction: column; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #30363d; }
.sidebar-header h2 { font-size: 16px; color: #58a6ff; }
.sidebar-header .version-btn { font-size: 12px; color: #8b949e; cursor: pointer; padding: 2px 8px; border-radius: 4px; border: 1px solid #30363d; background: none; }
.sidebar-header .version-btn:hover { color: #58a6ff; border-color: #58a6ff; }
.sidebar ul { list-style: none; flex: 1; }
.sidebar li { margin-bottom: 4px; }
.sidebar a { color: #8b949e; text-decoration: none; font-size: 14px; display: block; padding: 4px 8px; border-radius: 4px; transition: all 0.2s; cursor: pointer; }
.sidebar a:hover { color: #58a6ff; background: #1c2333; }
.sidebar .nav-group { color: #484f58; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding: 12px 8px 4px; font-weight: 600; }
.content { flex: 1; padding: 40px; overflow-y: auto; max-width: 900px; }
.content h1 { font-size: 28px; margin-bottom: 20px; color: #f0f6fc; }
.content h2 { font-size: 22px; margin-top: 28px; margin-bottom: 12px; color: #f0f6fc; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
.content h3 { font-size: 18px; margin-top: 20px; margin-bottom: 8px; color: #f0f6fc; }
.content p { line-height: 1.7; margin-bottom: 16px; color: #c9d1d9; }
.content code { background: #1c2333; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
.content pre { background: #161b22; padding: 16px; border-radius: 6px; overflow-x: auto; margin-bottom: 16px; border: 1px solid #30363d; }
.content pre code { background: none; padding: 0; }
.content table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
.content th, .content td { border: 1px solid #30363d; padding: 8px 12px; text-align: left; }
.content th { background: #161b22; color: #f0f6fc; }
.content a { color: #58a6ff; }
.content a.source-ref { color: #8b949e; font-size: 13px; text-decoration: none; border: 1px solid #30363d; border-radius: 3px; padding: 1px 6px; margin-left: 4px; }
.content a.source-ref:hover { color: #58a6ff; border-color: #58a6ff; }
.content blockquote { border-left: 4px solid #30363d; padding-left: 16px; color: #8b949e; margin-bottom: 16px; }
.content ul, .content ol { margin-bottom: 16px; padding-left: 24px; }
.content li { margin-bottom: 4px; }
.content .mermaid { text-align: center; margin: 20px 0; background: #161b22; padding: 20px; border-radius: 6px; border: 1px solid #30363d; }
.overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 100; justify-content: center; align-items: center; }
.overlay.show { display: flex; }
.overlay-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; min-width: 360px; max-height: 80vh; overflow-y: auto; }
.overlay-box h3 { color: #f0f6fc; font-size: 16px; margin-bottom: 16px; }
.overlay-box a { display: block; color: #8b949e; text-decoration: none; padding: 8px 12px; border-radius: 4px; font-size: 14px; margin-bottom: 4px; transition: all 0.2s; }
.overlay-box a:hover { color: #58a6ff; background: #1c2333; }
.overlay-box a.current { color: #58a6ff; background: #1c2333; font-weight: 600; }
.overlay-box .close-btn { float: right; color: #8b949e; cursor: pointer; font-size: 18px; padding: 0 4px; }
.overlay-box .close-btn:hover { color: #f0f6fc; }
.chat-panel { width: 380px; flex-shrink: 0; display: none; flex-direction: column; border-left: 1px solid #30363d; background: #161b22; }
.chat-panel.open { display: flex; }
.chat-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #30363d; }
.chat-header span { font-size: 14px; font-weight: 600; color: #f0f6fc; }
.chat-header button { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px; }
.chat-header button:hover { color: #f0f6fc; background: #1c2333; }
.chat-messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.chat-msg { padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; max-width: 100%; word-break: break-word; }
.chat-msg.user { background: #1c2333; align-self: flex-end; color: #f0f6fc; }
.chat-msg.assistant { background: #0d1117; border: 1px solid #30363d; align-self: flex-start; color: #c9d1d9; }
.chat-msg.reasoning { font-style: italic; color: #8b949e; font-size: 12px; align-self: flex-start; }
.chat-msg.tool { font-size: 12px; color: #58a6ff; align-self: flex-start; font-family: 'JetBrains Mono', monospace; }
.chat-msg.tool-result { font-size: 11px; color: #8b949e; align-self: flex-start; }
.chat-msg.error { color: #f85149; align-self: flex-start; }
.chat-msg code { background: #1c2333; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.chat-msg pre { background: #0d1117; padding: 8px; border-radius: 4px; overflow-x: auto; margin: 4px 0; font-size: 12px; }
.chat-input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #30363d; }
.chat-input-area input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #f0f6fc; font-size: 13px; outline: none; }
.chat-input-area input:focus { border-color: #58a6ff; }
.chat-input-area input:disabled { opacity: 0.5; }
.chat-input-area button { background: #238636; border: none; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
.chat-input-area button:hover { background: #2ea043; }
.chat-input-area button:disabled { opacity: 0.5; cursor: default; }
.chat-input-area button:disabled:hover { background: #238636; }
.content.chat-open { max-width: none; }
</style>
</head>
<body>
<div class="wrapper">
<div class="sidebar">
  <div class="sidebar-header">
    <h2>📖 Wiki</h2>
    <button class="version-btn" onclick="showVersions()">历史版本</button>
  </div>
  <ul>${sidebarHtml}</ul>
</div>
<div class="content ${chatEnabled ? '' : 'chat-open'}" id="content">${firstContent}</div>
<div class="chat-panel" id="chatPanel">
  <div class="chat-header">
    <span>💬 AI</span>
    <button onclick="toggleChat()" title="关闭 AI 面板">✕</button>
  </div>
  <div class="chat-messages" id="chatMessages"></div>
  ${chatEnabled ? `
  <div class="chat-input-area">
    <input id="chatInput" placeholder="Ask about the codebase..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}"/>
    <button id="chatSend" onclick="sendChat()">Send</button>
  </div>` : `
  <div class="chat-input-area" style="justify-content:center;color:#8b949e;font-size:13px">
    请先运行 <code>wiki-cli config</code> 配置 LLM
  </div>`}
</div>
</div>
<div class="overlay" id="versionOverlay" onclick="if(event.target===this)hideVersions()">
  <div class="overlay-box">
    <span class="close-btn" onclick="hideVersions()">✕</span>
    <h3>历史版本</h3>
    ${versionsHtml}
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
const currentVersion = ${JSON.stringify(currentVersion)};
const wikiSlugs = ${JSON.stringify(slugs)};

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

async function loadPage(encodedSlug) {
  const slug = decodeURIComponent(encodedSlug);
  const res = await fetch('/api/page/' + slug + '.md?version=' + currentVersion);
  const html = await res.text();
  document.getElementById('content').innerHTML = html;
  document.getElementById('content').scrollTop = 0;
  hljs.highlightAll();
  try { await mermaid.run({ nodes: document.querySelectorAll('.mermaid') }); } catch {}
  history.replaceState(null, '', '#' + slug);
}

function switchVersion(ts) {
  window.location.href = '/?version=' + ts;
}

function showVersions() {
  document.getElementById('versionOverlay').classList.add('show');
}

function hideVersions() {
  document.getElementById('versionOverlay').classList.remove('show');
}

document.addEventListener('DOMContentLoaded', function() {
  hljs.highlightAll();
  try { mermaid.run({ nodes: document.querySelectorAll('.mermaid') }); } catch {}

  if (location.hash) {
    const slug = decodeURIComponent(location.hash.slice(1));
    loadPage(slug);
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideVersions();
  });

  document.getElementById('content').addEventListener('click', function(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('/api/') || href.startsWith('#') || href.startsWith('mailto:')) return;
    e.preventDefault();
    if (href.endsWith('.md')) {
      loadPage(href.replace(/\\.md$/, ''));
    } else {
      const srcPath = href.startsWith('/') ? href.slice(1) : href;
      window.open('/api/source/' + srcPath, '_blank');
    }
  });
});

// Chat
let chatSessionId = localStorage.getItem('wikiChatSessionId') || '';
let isStreaming = false;

function toggleChat() {
  const panel = document.getElementById('chatPanel');
  const content = document.getElementById('content');
  panel.classList.toggle('open');
  content.classList.toggle('chat-open');
  localStorage.setItem('wikiChatOpen', panel.classList.contains('open'));
  if (panel.classList.contains('open')) {
    document.getElementById('chatInput')?.focus();
  }
}

async function sendChat() {
  if (isStreaming) return;
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  isStreaming = true;
  input.disabled = true;
  document.getElementById('chatSend').disabled = true;

  addChatMsg('user', msg);
  const msgContainer = addChatMsg('assistant', '');

  try {
    const res = await fetch('/api/chat/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, sessionId: chatSessionId || undefined }),
    });
    if (!res.ok) { addChatMsg('error', await res.text()); isStreaming = false; input.disabled = false; document.getElementById('chatSend').disabled = false; return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'content') {
            msgContainer.textContent += data.text;
          } else if (data.type === 'reasoning') {
            // append to a reasoning element or ignore in content display
          } else if (data.type === 'tool_call') {
            addChatMsg('tool', '🔧 ' + data.name + '(' + data.args.slice(0, 80) + (data.args.length > 80 ? '...' : '') + ')');
          } else if (data.type === 'tool_result') {
            addChatMsg('tool-result', '📦 ' + data.name + ': ' + data.summary.slice(0, 100));
          } else if (data.type === 'error') {
            addChatMsg('error', data.text);
          } else if (data.type === 'done') {
            chatSessionId = data.sessionId;
            localStorage.setItem('wikiChatSessionId', chatSessionId);
          }
        } catch {}
      }
    }
  } catch (err) {
    addChatMsg('error', err.message);
  }
  isStreaming = false;
  input.disabled = false;
  document.getElementById('chatSend').disabled = false;
  input.focus();
}

function addChatMsg(role, text) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

// Restore chat state
document.addEventListener('DOMContentLoaded', function() {
  const chatOpen = localStorage.getItem('wikiChatOpen') === 'true';
  if (chatOpen) {
    document.getElementById('chatPanel').classList.add('open');
    document.getElementById('content').classList.add('chat-open');
  }
  // Restore session history
  if (chatSessionId) {
    fetch('/api/chat/?session=' + chatSessionId).then(r => r.json()).then(session => {
      if (session && session.messages) {
        for (const m of session.messages) {
          if (m.role === 'user') addChatMsg('user', m.content || '');
          else if (m.role === 'assistant') addChatMsg('assistant', m.content || '(tool calls)');
        }
      }
    }).catch(() => {});
  }
});
</script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
