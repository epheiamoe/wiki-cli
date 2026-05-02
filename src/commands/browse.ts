import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { marked } from 'marked';
import { logInfo, logSuccess, logError } from '../utils/progress.js';

export async function browseCommand(): Promise<void> {
  const wikiDir = resolve(process.cwd(), '.wiki');

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

  const indexMdPath = join(wikiPath, 'index.md');
  let sidebarItems: { title: string; slug: string; level: string }[] = [];
  let firstPage: string | null = null;

  if (existsSync(indexMdPath)) {
    const indexContent = await readFile(indexMdPath, 'utf-8');
    sidebarItems = parseIndex(indexContent);
    if (sidebarItems.length > 0) {
      firstPage = join(wikiPath, `${sidebarItems[0].slug}.md`);
    }
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      let pathname = url.pathname;

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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } else {
          res.writeHead(404);
          res.end('Page not found');
        }
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

function parseIndex(content: string): { title: string; slug: string; level: string }[] {
  const items: { title: string; slug: string; level: string }[] = [];
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

    const topicMatch = trimmed.match(/<topic\s+level="([^"]*)">([^<]*)<\/topic>/);
    if (topicMatch) {
      const level = topicMatch[1];
      const title = topicMatch[2];
      const slug = slugify(title);
      items.push({ title, slug, level });
      continue;
    }

    const groupMatch = trimmed.match(/<group>([^<]*)<\/group>/);
    if (groupMatch) {
      items.push({ title: groupMatch[1], slug: '', level: 'group' });
    }
  }

  return items;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

function buildSidebarHtml(items: { title: string; slug: string; level: string }[]): string {
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

async function serveHtml(res: ServerResponse, wikiPath: string, sidebarItems: { title: string; slug: string; level: string }[], firstPage: string | null): Promise<void> {
  let firstContent = '';
  if (firstPage && existsSync(firstPage)) {
    const md = await readFile(firstPage, 'utf-8');
    firstContent = await marked.parse(md);
  }

  const sidebarHtml = buildSidebarHtml(sidebarItems);

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
.sidebar a { color: #8b949e; text-decoration: none; font-size: 14px; display: block; padding: 4px 8px; border-radius: 4px; transition: all 0.2s; }
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
async function loadPage(encodedSlug) {
  const slug = decodeURIComponent(encodedSlug);
  const res = await fetch('/api/page/' + slug + '.md');
  const html = await res.text();
  document.getElementById('content').innerHTML = html;
  hljs.highlightAll();
}
document.addEventListener('DOMContentLoaded', hljs.highlightAll);
</script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
