import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

export interface ToolResult {
  type: 'success' | 'error';
  data: any;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'Get the directory structure tree',
      parameters: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: 'Directory path' },
          max_depth: { type: 'number', description: 'Maximum depth (default 3)', nullable: true }
        },
        required: ['dir_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory, optionally filtered by extension',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to filter (e.g. [".ts", ".js"])', nullable: true }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file, optionally limiting to a line range',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File path' },
          start_line: { type: 'number', description: 'Start line (1-indexed)', nullable: true },
          end_line: { type: 'number', description: 'End line (inclusive)', nullable: true }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_in_files',
      description: 'Search for a pattern (keyword or regex) in files',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root path to search in' },
          pattern: { type: 'string', description: 'Search pattern (regex supported)' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to filter', nullable: true }
        },
        required: ['path', 'pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Get Git commit history',
      parameters: {
        type: 'object',
        properties: {
          max_count: { type: 'number', description: 'Maximum number of commits', nullable: true },
          path: { type: 'string', description: 'File or directory path to filter', nullable: true }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_show',
      description: 'Show details of a Git object (commit, tree, blob, tag)',
      parameters: {
        type: 'object',
        properties: {
          object: { type: 'string', description: 'Git object reference (commit hash, branch, etc.)' },
          path: { type: 'string', description: 'File path within the commit', nullable: true }
        },
        required: ['object']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_remote_info',
      description: 'Get remote repository information',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dotenv_template',
      description: 'Read the .env.example template file',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_wiki_pages',
      description: 'List all available Wiki pages with their slugs',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_wiki',
      description: 'Read a Wiki page by slug',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The page slug (without .md extension)' }
        },
        required: ['slug']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_wiki',
      description: 'Keyword search across all Wiki pages. Returns matching pages with content snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results (default 5)', nullable: true }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'semantic_search',
      description: 'Semantic search across Wiki using embeddings (if configured). Use when keyword search fails or for conceptual questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results (default 5)', nullable: true }
        },
        required: ['query']
      }
    }
  }
];

async function listDirectory(dirPath: string, maxDepth?: number): Promise<ToolResult> {
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      return { type: 'error', data: 'dir_path is required' };
    }
    const absPath = resolve(dirPath);
    if (!existsSync(absPath)) {
      return { type: 'error', data: `Directory not found: ${dirPath}` };
    }
    const tree = await buildTree(absPath, absPath, 0, maxDepth ?? 3);
    return { type: 'success', data: tree };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function buildTree(root: string, current: string, depth: number, maxDepth: number): Promise<any> {
  if (depth > maxDepth) return { name: '...', type: 'truncated' };
  const name = relative(root, current) || '.';
  const entry = { name, type: 'directory', children: [] as any[] };
  const items = await readdir(current, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const fullPath = join(current, item.name);
    if (item.isDirectory()) {
      const child = await buildTree(root, fullPath, depth + 1, maxDepth);
      entry.children.push(child);
    } else {
      entry.children.push({ name: item.name, type: 'file' });
    }
  }
  return entry;
}

async function listFiles(path: string, extensions?: string[]): Promise<ToolResult> {
  try {
    if (!path || typeof path !== 'string') {
      return { type: 'error', data: 'path is required' };
    }
    const absPath = resolve(path);
    if (!existsSync(absPath)) {
      return { type: 'error', data: `Path not found: ${path}` };
    }
    const result: string[] = [];
    await collectFiles(absPath, result, extensions);
    return { type: 'success', data: result };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function collectFiles(dir: string, result: string[], extensions?: string[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      await collectFiles(fullPath, result, extensions);
    } else if (item.isFile()) {
      if (!extensions || extensions.length === 0 || extensions.includes(extname(item.name))) {
        result.push(fullPath);
      }
    }
  }
}

async function readFileTool(filePath: string, startLine?: number, endLine?: number): Promise<ToolResult> {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { type: 'error', data: 'file_path is required' };
    }
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      return { type: 'error', data: `File not found: ${filePath}` };
    }
    const content = await readFile(absPath, 'utf-8');
    const lines = content.split('\n');
    if (startLine !== undefined) {
      const s = Math.max(0, startLine - 1);
      const e = endLine !== undefined ? endLine : lines.length;
      return { type: 'success', data: lines.slice(s, e).join('\n') };
    }
    return { type: 'success', data: content };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function searchInFiles(rootPath: string, pattern: string, extensions?: string[]): Promise<ToolResult> {
  try {
    if (!rootPath || typeof rootPath !== 'string') {
      return { type: 'error', data: 'path is required' };
    }
    const absPath = resolve(rootPath);
    if (!existsSync(absPath)) {
      return { type: 'error', data: `Path not found: ${rootPath}` };
    }
    const regex = new RegExp(pattern, 'i');
    const results: { file: string; line: number; content: string }[] = [];
    await searchInDir(absPath, absPath, regex, extensions, results);
    return { type: 'success', data: results };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function searchInDir(root: string, dir: string, regex: RegExp, extensions: string[] | undefined, results: { file: string; line: number; content: string }[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      await searchInDir(root, fullPath, regex, extensions, results);
    } else if (item.isFile()) {
      if (extensions && extensions.length > 0 && !extensions.includes(extname(item.name))) continue;
      try {
        const content = await readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({ file: relative(root, fullPath), line: i + 1, content: lines[i].trim() });
          }
        }
      } catch { }
    }
  }
}

async function gitLog(maxCount?: number, path?: string): Promise<ToolResult> {
  try {
    const count = maxCount ?? 20;
    let cmd = `git log --oneline --max-count=${count}`;
    if (path) cmd += ` -- "${path}"`;
    const output = execSync(cmd, { encoding: 'utf-8', cwd: process.cwd() });
    return { type: 'success', data: output.trim() };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function gitShow(object: string, path?: string): Promise<ToolResult> {
  try {
    let cmd = `git show ${object}`;
    if (path) cmd += `:${path}`;
    const output = execSync(cmd, { encoding: 'utf-8', cwd: process.cwd() });
    return { type: 'success', data: output };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function gitRemoteInfo(): Promise<ToolResult> {
  try {
    const output = execSync('git remote -v', { encoding: 'utf-8', cwd: process.cwd() });
    const lines = output.trim().split('\n').filter(Boolean);
    const remotes = lines.map(line => {
      const parts = line.split(/\s+/);
      return { name: parts[0], url: parts[1], type: parts[2]?.replace(/[()]/g, '') || 'unknown' };
    });
    return { type: 'success', data: remotes };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function dotenvTemplate(): Promise<ToolResult> {
  try {
    const envPath = join(process.cwd(), '.env.example');
    if (!existsSync(envPath)) {
      return { type: 'error', data: '.env.example not found in current directory' };
    }
    const content = await readFile(envPath, 'utf-8');
    return { type: 'success', data: content };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

const WIKI_DIR = resolve(process.cwd(), '.wiki');

async function findLatestWikiDir(): Promise<string | null> {
  try {
    if (!existsSync(WIKI_DIR)) return null;
    const entries = await readdir(WIKI_DIR, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
      .map(e => e.name)
      .sort()
      .reverse();
    return dirs.length > 0 ? join(WIKI_DIR, dirs[0]) : null;
  } catch {
    return null;
  }
}

async function listWikiPages(): Promise<ToolResult> {
  try {
    const wikiPath = await findLatestWikiDir();
    if (!wikiPath) return { type: 'error', data: 'No wiki found. Run wiki-cli generate first.' };

    // Try index.json first
    const jsonPath = join(wikiPath, 'index.json');
    if (existsSync(jsonPath)) {
      const raw = await readFile(jsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const pages: string[] = [];
      for (const section of parsed.sections || []) {
        for (const topic of section.topics || []) {
          if (topic.type !== 'group' && topic.title) {
            const slug = topic.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
            pages.push(`- ${slug}.md | 标题: ${topic.title} | 章节: ${section.name || ''} | 难度: ${topic.level || '中级'}`);
          }
        }
      }
      return { type: 'success', data: pages };
    }

    // Fallback: scan .md files
    const files = await readdir(wikiPath);
    const mdFiles = files
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .sort()
      .map(f => `- ${f}`);
    if (mdFiles.length > 0) {
      return { type: 'success', data: mdFiles };
    }

    return { type: 'success', data: ['No wiki pages found'] };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function readWiki(slug: string): Promise<ToolResult> {
  try {
    if (!slug || typeof slug !== 'string') {
      return { type: 'error', data: 'slug is required' };
    }
    const wikiPath = await findLatestWikiDir();
    if (!wikiPath) return { type: 'error', data: 'No wiki found. Run wiki-cli generate first.' };

    const mdPath = join(wikiPath, `${slug.replace(/\.md$/, '')}.md`);
    if (!existsSync(mdPath)) {
      // Fuzzy match: search for files containing the slug
      const files = await readdir(wikiPath);
      const match = files.find(f => f.endsWith('.md') && f !== 'index.md' && (f === `${slug}.md` || f.replace(/\.md$/, '').includes(slug) || slug.includes(f.replace(/\.md$/, ''))));
      if (match) {
        const content = await readFile(join(wikiPath, match), 'utf-8');
        return { type: 'success', data: content };
      }
      return { type: 'error', data: `Page not found: ${slug}.md` };
    }

    const content = await readFile(mdPath, 'utf-8');
    return { type: 'success', data: content };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

// Embedding config for semantic search (set at runtime)
let embeddingConfig: { provider: string; model: string; baseUrl: string; apiKey: string } | null = null;

export function initTools(embConfig?: { provider: string; model: string; baseUrl: string; apiKey: string }): void {
  embeddingConfig = embConfig || null;
}

async function searchWiki(query: string, maxResults?: number): Promise<ToolResult> {
  try {
    if (!query || typeof query !== 'string') return { type: 'error', data: 'query is required' };
    const wikiPath = await findLatestWikiDir();
    if (!wikiPath) return { type: 'error', data: 'No wiki found.' };

    const max = maxResults || 5;
    const files = await readdir(wikiPath);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md').sort();
    const results: { slug: string; title: string; snippet: string; score: number }[] = [];

    // Try index.json for title mapping
    const jsonPath = join(wikiPath, 'index.json');
    let titleMap: Record<string, string> = {};
    if (existsSync(jsonPath)) {
      try {
        const raw = await readFile(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const s of parsed.sections || []) {
          for (const t of s.topics || []) {
            if (t.type !== 'group' && t.title) {
              const slug = t.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
              titleMap[slug] = t.title;
            }
          }
        }
      } catch { /* ignore */ }
    }

    const queryLower = query.toLowerCase();
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(wikiPath, file), 'utf-8');
        const contentLower = content.toLowerCase();
        if (contentLower.includes(queryLower)) {
          const slug = file.replace(/\.md$/, '');
          const title = titleMap[slug] || slug;
          // Extract snippet around first match
          const idx = contentLower.indexOf(queryLower);
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + query.length + 120);
          let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
          if (start > 0) snippet = '...' + snippet;
          if (end < content.length) snippet = snippet + '...';
          results.push({ slug, title, snippet, score: 1 });
        }
      } catch { /* skip unreadable */ }
    }

    return { type: 'success', data: results.slice(0, max) };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

async function semanticSearch(query: string, maxResults?: number): Promise<ToolResult> {
  try {
    if (!query || typeof query !== 'string') return { type: 'error', data: 'query is required' };
    if (!embeddingConfig) return { type: 'error', data: 'Embedding not configured. Run wiki-cli config to set up.' };

    const wikiPath = await findLatestWikiDir();
    if (!wikiPath) return { type: 'error', data: 'No wiki found.' };

    const files = await readdir(wikiPath);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md').sort();
    if (mdFiles.length === 0) return { type: 'error', data: 'No wiki pages found.' };

    const { semanticSearch: doSearch } = await import('./embeddings.js');
    const searchResults = await doSearch(query, wikiPath, embeddingConfig, mdFiles, maxResults || 5);

    // Attach titles from index.json
    const jsonPath = join(wikiPath, 'index.json');
    let titleMap: Record<string, string> = {};
    if (existsSync(jsonPath)) {
      try {
        const raw = await readFile(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const s of parsed.sections || []) {
          for (const t of s.topics || []) {
            if (t.type !== 'group' && t.title) {
              const slug = t.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
              titleMap[slug] = t.title;
            }
          }
        }
      } catch { /* ignore */ }
    }

    const results = searchResults.map(r => ({
      slug: r.slug,
      title: titleMap[r.slug] || r.slug,
      score: Math.round(r.score * 1000) / 1000,
    }));

    return { type: 'success', data: results };
  } catch (err: any) {
    return { type: 'error', data: err.message };
  }
}

const toolHandlers: Record<string, (args: any) => Promise<ToolResult>> = {
  list_directory: (args) => listDirectory(args.dir_path, args.max_depth),
  list_files: (args) => listFiles(args.path, args.extensions),
  read_file: (args) => readFileTool(args.file_path, args.start_line, args.end_line),
  search_in_files: (args) => searchInFiles(args.path, args.pattern, args.extensions),
  git_log: (args) => gitLog(args.max_count, args.path),
  git_show: (args) => gitShow(args.object, args.path),
  git_remote_info: () => gitRemoteInfo(),
  dotenv_template: () => dotenvTemplate(),
  list_wiki_pages: () => listWikiPages(),
  read_wiki: (args) => readWiki(args.slug),
  search_wiki: (args) => searchWiki(args.query, args.max_results),
  semantic_search: (args) => semanticSearch(args.query, args.max_results),
};

export async function executeToolCall(name: string, args: any): Promise<ToolResult> {
  const handler = toolHandlers[name];
  if (!handler) {
    return { type: 'error', data: `Unknown tool: ${name}` };
  }
  return handler(args);
}
