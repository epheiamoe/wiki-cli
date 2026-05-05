---
name: wiki-cli-tools
description: |
  使用 wiki-cli 工具访问结构化代码库文档、语义搜索和网页抓取功能。
  仅当用户要求你使用 wiki-cli 时触发，因为可能项目并没有 wiki 文档。
---

# Wiki CLI Tools

This skill lets you use `wiki-cli` commands to read structured Wiki documentation,
perform semantic search across a codebase, fetch web pages as clean Markdown,
chat with a Wiki-aware AI about the codebase, and manage Wiki versions.

## Prerequisites

If `wiki-cli` is not available as a command, tell the user it needs to be installed:

```bash
npm install -g wiki-cli
# or
npx wiki-cli --help
```

If the user authorizes installation, you may install it yourself via `npm install -g wiki-cli`.
The source repository is at https://github.com/epheiamoe/wiki-cli.

## Available Tools

All tools output JSON to stdout with format `{"type":"success"|"error","data":...}`.

### Wiki-Aware AI Query

For open-ended questions about architecture, design patterns, or API usage that
require synthesis across multiple files, use the Wiki-aware AI:

```bash
wiki-cli ai -q "<your question about the codebase>" -a
```

The AI will:
1. First read the Wiki to get the project overview
2. Then explore specific source files as needed
3. Return a structured answer with source citations

**Important**: This tool takes 10-45 seconds (LLM response + tool calls). It outputs
natural language, not JSON. Use it when you need a synthesized understanding, not
just a raw data lookup. For simple lookups (single file read, keyword search, wiki
page read), use `tool-call` instead — it's faster and returns structured JSON.

### Semantic Search

```bash
wiki-cli tool-call semantic_search '{"query": "<search query>", "max_results": <number>}'
```

Searches Wiki pages using embedding similarity. Use this for conceptual questions
where keyword search would miss the mark. Requires Embedding to be configured
(`wiki-cli config` → Embedding) — if not configured, the tool returns an error.

### Keyword Wiki Search

```bash
wiki-cli tool-call search_wiki '{"query": "<keyword>", "max_results": <number>}'
```

Simple keyword-based search across all Wiki page content. Faster than semantic
search, good for finding specific terms, API names, or error messages.

### List Wiki Pages

```bash
wiki-cli tool-call list_wiki_pages '{}'
```

Returns all Wiki pages with their slugs, titles, sections, and difficulty levels.

### Read Wiki Page

```bash
wiki-cli tool-call read_wiki '{"slug": "<page-slug>"}'
```

Reads the full content of a Wiki page by its slug (without `.md` extension).

### Fetch Web Markdown

```bash
wiki-cli tool-call fetch_web_markdown '{"url": "https://..."}'
```

Fetches a URL and converts it to clean Markdown via Jina Reader. Use this when
you see a documentation URL, README link, or API reference that would help answer
the user's question. Only http/https URLs are allowed.

**Retry behavior**: The tool automatically retries on rate limits (429) and server
errors (5xx) with exponential backoff. Timeout is 15 seconds.

### File System & Git Tools

These are also available via `tool-call` but you likely have native equivalents:

- `list_directory(dir_path)` — directory tree
- `list_files(path, [extensions])` — filtered file listing
- `read_file(file_path, [start_line], [end_line])` — read file contents
- `search_in_files(path, pattern, [extensions])` — regex file search
- `git_log([max_count], [path])` — commit history
- `git_show(object, [path])` — git object details
- `git_remote_info()` — remote URLs
- `dotenv_template()` — read `.env.example`

## Checking Documentation Freshness

Before relying on Wiki content, especially for detailed technical answers,
check whether the Wiki is up to date:

```bash
wiki-cli status
```

- If output says **"✅ Wiki 是最新的"** → the Wiki matches the current git HEAD. Safe to use.
- If output says **"⚠ Wiki 已过时"** with a small number of commits behind → the Wiki
  is slightly outdated but likely still useful. Mention the staleness to the user.
- If output says **"⚠ Wiki 已过时"** with many commits behind → **do not rely on Wiki
  content for technical accuracy**. Tell the user the Wiki is significantly outdated
  and suggest regeneration.
- If output says **"⚡ 该版本生成时尚未启用元数据追踪"** → the Wiki exists but lacks
  metadata. Content may still be useful; use your judgment.
- If output says **"（非 git 项目）"** → the project is not a git repo. Wiki content
  is as-is; no freshness tracking available.

You can also view the changelog since the Wiki was generated:

```bash
wiki-cli status --log      # brief log
wiki-cli status --stat     # log with file stats
```

## When to Ask the User

Wiki-related decisions benefit from user input because:

- **Regenerating the Wiki costs API credits** (LLM calls). The user should decide
  whether to spend those credits.
- **The user may know the codebase has changed in ways that affect documentation**,
  even if the Wiki status says it's up to date.
- **Some users prefer reading source directly** over generated documentation.

When suggesting Wiki-related actions, explain your reasoning briefly:

> "The Wiki is N commits behind the current codebase — I suggest regenerating it
> to ensure accuracy. This will use your LLM API credits to re-analyze the
> changed files. Would you like me to run `wiki-cli generate`?"

## Updating the Wiki

**Do not run `wiki-cli generate` unless the user explicitly authorizes it.**
If authorized, consider whether to run in the background:

```bash
# Generate in background, log to temp file
wiki-cli generate --silent --parallel > /tmp/wiki-gen.log 2>&1 &
WIKI_PID=$!
```

After spawning, inform the user and check progress by polling the log file:

```bash
# Check progress
tail -20 /tmp/wiki-gen.log

# Check if done
if grep -q "Wiki generated at" /tmp/wiki-gen.log; then
  echo "Generation complete"
fi
```

If the user has no other tasks, poll periodically (every 10-15 seconds) until
the generation finishes, then report the result. If the user has other work,
prioritize that and check back when convenient.

**Flags to consider when generating:**
- `--silent` — no interactive prompts (essential for background mode)
- `--parallel` — much faster for projects with many pages
- `-c <N>` — concurrency (default 3)
- `--browse` — auto-start browser after completion (only if user wants it)
- `-b <branch>` — checkout specific branch first
- `--url <url>` — clone remote repo first

## Working Directory

All `wiki-cli` commands should be run in the project's root directory (where
`.wiki/` lives, or where the source code is). Use `-C <path>` if needed.
