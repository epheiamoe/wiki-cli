import { readFile, readdir } from 'node:fs/promises';
import { join, extname, resolve, sep, normalize, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { logInfo, logSuccess, logError } from '../utils/progress.js';
import { stripCodeFence } from '../ai/llm-client.js';

const PROJECT_ROOT = resolve(process.cwd());

export interface BrowseOptions {
  path?: string;
}

export async function browseCommand(options?: BrowseOptions): Promise<void> {
  let wikiDir: string;

  if (options?.path) {
    wikiDir = resolve(options.path);
    // If it points to a version dir directly, use the parent .wiki
    if (existsSync(wikiDir) && basename(dirname(wikiDir)) === '.wiki') {
      wikiDir = dirname(wikiDir);
    }
    // If it points to a project dir, look for .wiki inside
    if (existsSync(wikiDir) && basename(wikiDir) !== '.wiki') {
      const nested = join(wikiDir, '.wiki');
      if (existsSync(nested)) wikiDir = nested;
    }
  } else {
    wikiDir = join(PROJECT_ROOT, '.wiki');
  }

  if (!existsSync(wikiDir)) {
    logError(`Wiki directory not found: ${wikiDir}`);
    logError('Run "wiki-cli generate" first or specify correct path.');
    process.exit(1);
  }

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
        await serveHtml(res, wikiPath, sidebarItems, firstPage, allVersions, version);
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

function sanitizePath(rawPath: string): string | null {
  const cleaned = rawPath.replace(/^[/\\]+/, '');
  const normalized = normalize(cleaned).replace(/^(\.\.(\/|\\))+/g, '');
  const resolved = resolve(PROJECT_ROOT, normalized);
  if (!resolved.startsWith(PROJECT_ROOT + sep) && resolved !== PROJECT_ROOT) return null;
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
  currentVersion: string
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
<div class="content" id="content">${firstContent}</div>
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
</script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
