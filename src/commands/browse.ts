import { readFile, readdir } from 'node:fs/promises';
import { join, extname, resolve, sep, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { marked } from 'marked';
import { logInfo, logSuccess, logError } from '../utils/progress.js';
import { stripCodeFence } from '../ai/llm-client.js';

const PROJECT_ROOT = resolve(process.cwd());

export async function browseCommand(): Promise<void> {
  const wikiDir = join(PROJECT_ROOT, '.wiki');

  if (!existsSync(wikiDir)) {
    logError('No .wiki directory found. Run "wiki-cli generate" first.');
    process.exit(1);
  }

  const entries = await readdir(wikiDir, { withFileTypes: true });
  const timestamps = entries
    .filter(e => e.isDirectory() && e.name !== 'temp')
    .map(e => e.name)
    .sort()
    .reverse();

  if (timestamps.length === 0) {
    logError('No generated Wiki found. Run "wiki-cli generate" first.');
    process.exit(1);
  }

  const latest = timestamps[0];
  const wikiPath = join(wikiDir, latest);
  logInfo(`Browsing Wiki: ${latest}`);

  const sidebarItems = await loadSidebar(wikiPath);
  const firstPage = sidebarItems.length > 0 ? join(wikiPath, `${sidebarItems[0].slug}.md`) : null;

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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const pathname = url.pathname;

      if (pathname === '/') {
        await serveHtml(res, wikiPath, sidebarItems, firstPage);
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
        const safePath = sanitizePath(rawPath);
        if (!safePath) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const fullPath = join(PROJECT_ROOT, safePath);
        if (!existsSync(fullPath)) {
          res.writeHead(404);
          res.end('Source file not found');
          return;
        }
        const content = await readFile(fullPath, 'utf-8');
        const ext = extname(fullPath);
        const lang = extToLang(ext);
        const fileName = pathname.slice(12);
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
.header a { color: #58a6ff; text-decoration: none; font-size: 14px; }
.header a:hover { text-decoration: underline; }
.header span { color: #8b949e; font-size: 13px; }
.header .path { color: #f0f6fc; font-size: 14px; font-family: 'JetBrains Mono', 'Fira Code', monospace; }
pre { padding: 20px 24px; overflow-x: auto; margin: 0; }
pre code { font-size: 13px; line-height: 1.6; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; }
</style>
</head>
<body>
<div class="header">
  <a href="/">← Wiki</a>
  <span>|</span>
  <span class="path">${escapeHtml(fileName)}</span>
  <span style="margin-left:auto;background:#1c2333;padding:2px 10px;border-radius:4px;font-size:12px;color:#8b949e">${lang}</span>
</div>
<pre><code class="language-${lang}">${escapeHtml(content)}</code></pre>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>hljs.highlightAll();</script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(sourceHtml);
        return;
      }

      // Redirect .md requests to the API route
      if (pathname.endsWith('.md') && !pathname.startsWith('/api/')) {
        const slug = pathname.replace(/\.md$/, '').replace(/^\//, '');
        res.writeHead(302, { Location: '/api/page/' + encodeURIComponent(slug) + '.md' });
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

interface SidebarItem {
  title: string;
  slug: string;
  level: string;
}

async function loadSidebar(wikiPath: string): Promise<SidebarItem[]> {
  // Try index.json first (new format)
  const jsonPath = join(wikiPath, 'index.json');
  if (existsSync(jsonPath)) {
    try {
      const content = await readFile(jsonPath, 'utf-8');
      return parseIndexJson(content);
    } catch {
      // fall through to XML fallback
    }
  }

  // Fallback: try index.md with XML format (legacy)
  const mdPath = join(wikiPath, 'index.md');
  if (existsSync(mdPath)) {
    try {
      const content = await readFile(mdPath, 'utf-8');
      return parseIndexXml(content);
    } catch {
      // ignore
    }
  }

  // Last resort: scan .md files
  return [];
}

function parseIndexJson(content: string): SidebarItem[] {
  const cleaned = stripCodeFence(content);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!parsed.sections || !Array.isArray(parsed.sections)) return [];

  const items: SidebarItem[] = [];

  for (const section of parsed.sections) {
    if (!section.topics || !Array.isArray(section.topics)) continue;

    for (const topic of section.topics) {
      if (topic.type === 'group') {
        items.push({ title: topic.title, slug: '', level: 'group' });
      } else if (topic.title) {
        items.push({
          title: topic.title,
          slug: slugify(topic.title),
          level: topic.level || '中级',
        });
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

    if (trimmed.startsWith('<section>')) {
      inSection = true;
      continue;
    }
    if (trimmed.startsWith('</section>')) {
      inSection = false;
      continue;
    }
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

function sanitizePath(rawPath: string): string | null {
  const normalized = normalize(rawPath).replace(/^(\.\.(\/|\\))+/g, '');
  const resolved = resolve(PROJECT_ROOT, normalized);
  if (!resolved.startsWith(PROJECT_ROOT + sep) && resolved !== PROJECT_ROOT) {
    return null;
  }
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
  return html.replace(
    /\[来源：([^\]]+)\]/g,
    '<a href="/api/source/$1" target="_blank" class="source-ref">[来源]</a>'
  );
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function buildSidebarHtml(items: SidebarItem[]): string {
  const parts = items.map(item => {
    if (item.level === 'group') {
      return `<li class="nav-group">${item.title}</li>`;
    }
    const badge = item.level === '初学' ? '🟢' : item.level === '中级' ? '🟡' : '🔴';
    return `<li><a href="#" onclick="loadPage('${encodeURIComponent(item.slug)}')">${badge} ${item.title}</a></li>`;
  });
  return parts.join('\n');
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
    srv.on('error', () => {
      resolve(findFreePort(preferred + 1));
    });
  });
}

async function serveHtml(res: ServerResponse, wikiPath: string, sidebarItems: SidebarItem[], firstPage: string | null): Promise<void> {
  let firstContent = '';
  if (firstPage && existsSync(firstPage)) {
    const md = await readFile(firstPage, 'utf-8');
    firstContent = fixContentReferences(await marked.parse(md));
  }

  const sidebarHtml = buildSidebarHtml(sidebarItems);
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
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; height: 100vh; background: #0d1117; color: #c9d1d9; }
.sidebar { width: 280px; background: #161b22; border-right: 1px solid #30363d; padding: 20px; overflow-y: auto; flex-shrink: 0; }
.sidebar h2 { font-size: 16px; color: #58a6ff; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #30363d; }
.sidebar ul { list-style: none; }
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
</style>
</head>
<body>
<div class="sidebar">
  <h2>📖 Wiki</h2>
  <ul>${sidebarHtml}</ul>
</div>
<div class="content" id="content">${firstContent}</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
const wikiSlugs = ${JSON.stringify(slugs)};

async function loadPage(encodedSlug) {
  const slug = decodeURIComponent(encodedSlug);
  const res = await fetch('/api/page/' + slug + '.md');
  const html = await res.text();
  document.getElementById('content').innerHTML = html;
  document.getElementById('content').scrollTop = 0;
  hljs.highlightAll();
  history.replaceState(null, '', '#' + slug);
}

document.addEventListener('DOMContentLoaded', function() {
  hljs.highlightAll();

  if (location.hash) {
    const slug = decodeURIComponent(location.hash.slice(1));
    loadPage(slug);
  }

  document.getElementById('content').addEventListener('click', function(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('/api/') || href.startsWith('#') || href.startsWith('mailto:')) return;
    e.preventDefault();
    if (href.endsWith('.md')) {
      loadPage(href.replace(/\\.md$/, ''));
    } else {
      window.open('/api/source/' + href, '_blank');
    }
  });
});
</script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
