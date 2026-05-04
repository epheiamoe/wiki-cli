现在我有足够的信息来撰写完整的页面。

---

# 工具系统与 Function Calling

## 架构总览

整个工具系统的设计遵循三层架构：**Schema 定义层**（`toolDefinitions`）负责向 LLM 声明可用工具的契约；**Handler 分派层**（`toolHandlers`）负责将工具名称映射到具体实现；**统一入口层**（`executeToolCall`）负责接收 LLM 发起的调用请求并路由到正确的 handler。这种三层分离使得工具的声明、实现和调用三者解耦，任一层可独立变更不影响其他层。

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM (模型侧)                              │
│  根据 toolDefinitions 中的 JSON Schema 决定调用哪个工具      │
└──────────────────────────┬──────────────────────────────────┘
                           │ tool call: {name, arguments}
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              executeToolCall(name, args)                     │
│  统一入口：查找 toolHandlers[name]，不存在则返回 error        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              toolHandlers[name](args)                        │
│  分派到具体实现：list_directory / read_file / git_log ...    │
└─────────────────────────────────────────────────────────────┘
```

[来源](src/ai/tools.ts#L1-L13)

---

## 第一层：ToolDefinition —— JSON Schema 契约

`ToolDefinition` 类型直接对标 OpenAI Function Calling 的 JSON Schema 格式：

```typescript
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}
```

[来源](src/ai/tools.ts#L8-L16)

`toolDefinitions` 数组包含 13 个工具，每个工具的 `parameters` 都遵循 JSON Schema 的 `type: 'object'` 规范，声明 `properties` 和 `required` 数组。测试对此有明确断言：

```typescript
it('each tool should have valid schema with type "object"', () => {
  for (const t of toolDefinitions) {
    expect(t.function.parameters.type).toBe('object');
  }
});
```

[来源](tests/tools.test.ts#L28-L32)

### 13 个工具的 Schema 一览

**文件工具**（4 个）：以目录或文件路径为基本操作单元。

| 工具名 | description | parameters | required |
|---|---|---|---|
| `list_directory` | Get the directory structure tree | `dir_path: string`, `max_depth?: number` | `['dir_path']` |
| `list_files` | List files in a directory, optionally filtered by extension | `path: string`, `extensions?: string[]` | `['path']` |
| `read_file` | Read the contents of a file, optionally limiting to a line range | `file_path: string`, `start_line?: number`, `end_line?: number` | `['file_path']` |
| `search_in_files` | Search for a pattern (keyword or regex) in files | `path: string`, `pattern: string`, `extensions?: string[]` | `['path', 'pattern']` |

**Git 工具**（3 个）：通过 `execSync` 调用本地 Git 命令。

| 工具名 | description | parameters | required |
|---|---|---|---|
| `git_log` | Get Git commit history | `max_count?: number`, `path?: string` | `[]` |
| `git_show` | Show details of a Git object (commit, tree, blob, tag) | `object: string`, `path?: string` | `['object']` |
| `git_remote_info` | Get remote repository information | `{}` | `[]` |

**Wiki 工具**（4 个）：基于 `.wiki/` 目录的只读操作。

| 工具名 | description | parameters | required |
|---|---|---|---|
| `list_wiki_pages` | List all available Wiki pages with their slugs | `{}` | `[]` |
| `read_wiki` | Read a Wiki page by slug | `slug: string` | `['slug']` |
| `search_wiki` | Keyword search across all Wiki pages | `query: string`, `max_results?: number` | `['query']` |
| `semantic_search` | Semantic search across Wiki using embeddings | `query: string`, `max_results?: number` | `['query']` |

**Web 工具**（1 个）：通过 Jina Reader API 将 URL 转为 Markdown。

| 工具名 | description | parameters | required |
|---|---|---|---|
| `fetch_web_markdown` | Fetch a URL and convert it to clean Markdown | `url: string` | `['url']` |

**其他**（1 个）：读取 `.env.example` 模板。

| 工具名 | description | parameters | required |
|---|---|---|---|
| `dotenv_template` | Read the .env.example template file | `{}` | `[]` |

[来源](src/ai/tools.ts#L18-L238)

---

## 第二层：toolHandlers —— 分派模式

`toolHandlers` 是一个 `Record<string, (args: any) => Promise<ToolResult>>` 类型的对象字面量，将 13 个工具名称直接映射到各自的实现函数：

```typescript
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
  fetch_web_markdown: (args) => fetchWebMarkdown(args.url),
};
```

[来源](src/ai/tools.ts#L438-L453)

### 分派模式的特点

1. **扁平映射**：不使用 `if/else` 或 `switch`，直接以对象查找代替分支判断，O(1) 时间复杂度。
2. **参数解耦**：handler 只接收 `args` 对象，由调用方保证参数的拼装正确性，handler 内部通过解构提取所需字段。
3. **无参工具**：`git_remote_info`、`dotenv_template`、`list_wiki_pages` 三个工具不接收参数，其 handler 为 `() => func()` 形式。
4. **统一返回类型**：所有 handler 返回 `Promise<ToolResult>`，即 `{ type: 'success' | 'error', data: any }`。

---

## 第三层：executeToolCall —— 统一入口

`executeToolCall` 是整个工具系统的门面函数。它接收 LLM 发来的工具调用请求（工具名 + 参数对象），在 `toolHandlers` 中查找对应的 handler，分派执行并返回结果：

```typescript
export async function executeToolCall(name: string, args: any): Promise<ToolResult> {
  const handler = toolHandlers[name];
  if (!handler) {
    return { type: 'error', data: `Unknown tool: ${name}` };
  }
  return handler(args);
}
```

[来源](src/ai/tools.ts#L455-L462)

### 调用链路（以 `ai.ts` 为例）

在交互式 AI 对话流程中，`executeToolCall` 被 `chatOnce` 和 `answerOnly` 函数在工具调用循环中调用：

```
LLM 返回 tool_calls
  → 解析 tool_calls 数组
    → 对每个 tool_call { name, arguments }
      → executeToolCall(name, args)
        → handler(args) 返回 Promise<ToolResult>
      → 将结果以 role: 'tool' 消息加入 messages 队列
    → 继续下一次 LLM 请求（最多 50 次迭代）
```

[来源](src/commands/ai.ts#L141-L171)

测试验证了完整的调用链路：

```typescript
it('should return error for unknown tool', async () => {
  const result = await executeToolCall('unknown_tool', {});
  expect(result.type).toBe('error');
});
```

[来源](tests/tools.test.ts#L84-L87)

---

## 分类阐释：四大工具组

### 文件工具

四个文件工具共享同一设计模式：使用 `node:fs/promises` 异步 API，先通过 `resolve()` 将相对路径转为绝对路径，再用 `existsSync()` 检查路径存在性，然后执行核心逻辑。错误处理全部包裹在 `try/catch` 中，异常信息透传给调用方。

**`listDirectory`** 递归构建目录树，默认深度 3，跳过 `.` 开头和 `node_modules` 目录。内部调用 `buildTree` 递归函数，超出最大深度时返回 `{ name: '...', type: 'truncated' }` 哨兵对象。[来源](src/ai/tools.ts#L240-L268)

**`listFiles`** 递归收集文件路径，通过 `extname` 匹配扩展名过滤。不传 `extensions` 时不过滤，返回所有文件。[来源](src/ai/tools.ts#L283-L304)

**`readFileTool`** 支持行范围截取（1-indexed，与编辑器和 CLI 工具对齐）。`startLine` 缺省时返回全文。[来源](src/ai/tools.ts#L306-L323)

**`searchInFiles`** 基于 `RegExp`（不区分大小写）跨文件搜索，返回匹配行及行号、内容片段。[来源](src/ai/tools.ts#L325-L356)

测试验证了这些工具的路径缺失保护、文件不存在处理、扩展名过滤等功能：[来源](tests/tools.test.ts#L37-L102)

### Git 工具

三个 Git 工具均通过 `execSync` 调用本地 Git 命令，`cwd` 设为 `process.cwd()`。之所以选择同步子进程而非 `execa` 或 `simple-git`，是为了保持零额外依赖——项目仅依赖 `commander`、`chalk` 和 `vitest`。

**`gitLog`** 默认返回最近 20 条提交的 oneline 格式。`path` 参数实现文件级别的历史过滤。[来源](src/ai/tools.ts#L358-L367)

**`gitShow`** 支持两种用法：`git show <commit>` 查看提交详情，`git show <commit>:<path>` 查看某个提交中的文件快照。[来源](src/ai/tools.ts#L369-L378)

**`gitRemoteInfo`** 解析 `git remote -v` 输出，将结果结构化为 `{name, url, type}[]` 数组。[来源](src/ai/tools.ts#L380-L391)

### Wiki 工具

Wiki 工具共享 `WIKI_DIR` 常量（`resolve(process.cwd(), '.wiki')`）和 `findLatestWikiDir` 辅助函数。后者在 `.wiki/` 下查找版本子目录（排除 `temp` 和 `sessions`），按字典序倒序取最新版本：

```typescript
async function findLatestWikiDir(): Promise<string | null> {
  const entries = await readdir(WIKI_DIR, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && e.name !== 'temp' && e.name !== 'sessions')
    .map(e => e.name).sort().reverse();
  return dirs.length > 0 ? join(WIKI_DIR, dirs[0]) : null;
}
```

[来源](src/ai/tools.ts#L399-L408)

**`listWikiPages`** 优先读取 `index.json`（由[生成引擎](生成wiki文档.md)生成的结构化索引），回退为扫描 `.md` 文件列表。[来源](src/ai/tools.ts#L410-L444)

**`readWiki`** 支持模糊匹配：当精确 slug 未找到时，遍历所有 `.md` 文件名进行包含匹配。[来源](src/ai/tools.ts#L446-L474)

**`searchWiki`** 是简单的全文关键词搜索（`String.includes`，不区分大小写），返回匹配页面的 slug、标题及上下文摘要片段。`max_results` 默认 5。[来源](src/ai/tools.ts#L492-L534)

**`semanticSearch`** 在运行时动态导入 `./embeddings.js`，调用 `doSearch` 进行向量相似度搜索。实现细节见[语义搜索实现](语义搜索实现.md)。[来源](src/ai/tools.ts#L536-L578)

### Web 工具

`fetchWebMarkdown` 通过 Jina Reader API（默认 `https://r.jina.ai`）将任意 URL 转为干净 Markdown。它实现了完整的重试机制：

```typescript
const maxRetries = 3;
// 429 (Rate Limit): 指数退避 2s → 4s → 8s
// 5xx (Server Error): 指数退避 1s → 2s → 4s
// AbortError (15s timeout): 自动重试
```

[来源](src/ai/tools.ts#L580-L643)

### dotenv_template

`dotenvTemplate` 读取当前工作目录下的 `.env.example` 文件内容。这为 LLM 提供了理解项目环境配置需求的能力。[来源](src/ai/tools.ts#L393-L403)

---

## 动态配置注入：initTools / getFilteredTools

工具系统的行为受运行时配置影响，通过两个函数实现动态控制。

### initTools —— 运行时注入

`initTools` 接收可选的 embedding 配置和 web fetch 配置，存入模块级变量：

```typescript
let embeddingConfig: { provider: string; model: string; baseUrl: string; apiKey: string } | null = null;
let webFetchConfig: { disabled?: boolean; baseUrl: string; apiKey?: string } | null = null;

export function initTools(embConfig?, webConfig?): void {
  embeddingConfig = embConfig || null;
  webFetchConfig = webConfig || null;
}
```

[来源](src/ai/tools.ts#L476-L482)

`initTools` 被三个入口调用：

| 调用方 | 时机 | 注入内容 |
|---|---|---|
| `src/commands/ai.ts` (L67-L77) | AI 问答启动时 | embedding 配置 + web fetch 配置 |
| `src/commands/generate.ts` (L121) | 文档生成启动时 | 仅 web fetch 配置 |
| `src/commands/tool-call.ts` (L24-L29) | 独立工具调用时 | embedding 配置 + web fetch 配置 |

[来源](src/commands/ai.ts#L67-L77) | [来源](src/commands/generate.ts#L121) | [来源](src/commands/tool-call.ts#L24-L29)

### getFilteredTools —— 声明式过滤

`getFilteredTools` 根据运行时状态决定哪些工具可见：

```typescript
export function getFilteredTools(): ToolDefinition[] {
  if (webFetchConfig?.disabled) {
    return toolDefinitions.filter(t => t.function.name !== 'fetch_web_markdown');
  }
  return toolDefinitions;
}
```

[来源](src/ai/tools.ts#L484-L489)

但这只是第一层过滤。第二层过滤发生在消费侧——`ai.ts` 中的 `chatOnce` 和 `answerOnly` 在将工具列表传递给 LLM 之前，会进一步跳过不符合当前条件的工具：

```typescript
const skipTools = new Set(['list_wiki_pages', 'read_wiki', 'search_wiki']);
if (!hasEmbedding) skipTools.add('semantic_search');
if (!hasWiki) {
  skipTools.add('list_wiki_pages'); skipTools.add('read_wiki');
  skipTools.add('search_wiki'); skipTools.add('semantic_search');
}
const allToolDefs = getFilteredTools().filter(t => !skipTools.has(t.function.name));
```

[来源](src/commands/ai.ts#L97-L119)

生成引擎也做了类似过滤，排除 Wiki 相关工具（生成阶段不需要它们）：

```typescript
const genTools = getFilteredTools().filter(
  t => !['list_wiki_pages', 'read_wiki', 'search_wiki', 'semantic_search'].includes(t.function.name)
);
```

[来源](src/commands/generate.ts#L365)

### 设计意图

双层过滤的设计体现了**关注点分离**：
- `getFilteredTools` 处理**基础设施级**的条件（如 Web Fetch 服务是否可用）。
- 消费侧过滤处理**业务级**的条件（如 Wiki 是否存在、Embedding 是否配置）。
- 这避免了将上层业务逻辑泄漏到工具定义层中。

---

## 消费入口与集成场景

工具系统在三个独立场景中被消费：

| 入口 | 用途 | 工具集 |
|---|---|---|
| `wiki-cli ai` (交互式/单次问答) | 开发者用自然语言提问代码库 | 全量工具（按条件过滤） |
| `wiki-cli tool-call <name> <args>` | JSON 输出接口，供 AI Agent 集成 | 全量工具（按配置过滤） |
| `wiki-cli generate` (内部调用) | 生成引擎的自我探索 | 排除 Wiki 工具的 9 个工具 |

具体到 `tool-call` 命令，它从配置文件中读取 embedding 和 web fetch 配置，调用 `initTools` 初始化后直接执行 `executeToolCall`，输出 JSON 到 stdout——这正是 [工具调用接口](工具调用接口.md) 和 [AI Agent Skill集成](ai-agent-skill集成.md) 的基础。

---

## 测试覆盖

`tests/tools.test.ts` 使用 `vitest` 框架，在临时目录中构造测试夹具以隔离文件系统副作用：

```typescript
const testDir = mkdtempSync(join(tmpdir(), 'wiki-cli-tools-test-'));
writeFileSync(join(testDir, 'test.txt'), 'hello world\nline 2\nline 3\n');
writeFileSync(join(testDir, 'app.ts'), 'const x: number = 1;\n');
mkdirSync(join(testDir, 'subdir'));
writeFileSync(join(testDir, 'subdir', 'nested.txt'), 'nested content');
```

[来源](tests/tools.test.ts#L6-L10)

### 测试维度

| 维度 | 用例数 | 覆盖要点 |
|---|---|---|
| Schema 完整性 | 3 | 13 个工具存在性、`type: 'object'` 校验 |
| 文件工具 | 10 | 正常读取、行范围、扩展名过滤、路径缺失、文件不存在 |
| 目录工具 | 2 | 树结构返回、参数缺失保护 |
| Git 工具 | 0 | （测试中未覆盖——依赖真实 Git 仓库） |
| Wiki 工具 | 5 | 参数缺失保护、不存在页面/查询的优雅处理 |
| 未知工具 | 1 | `executeToolCall` 的错误返回 |

测试缺 Git 工具的覆盖是因为这些工具依赖仓库环境，在临时目录中无法执行。这是一个已知的测试缺口。

[来源](tests/tools.test.ts#L12-L100)

---

## 推荐阅读

- [AI代码问答](ai代码问答.md) —— 工具系统在交互式对话中的完整调用流程
- [工具调用接口](工具调用接口.md) —— `tool-call` 命令作为 JSON 输出接口的详细规范
- [AI Agent Skill集成](ai-agent-skill集成.md) —— 将这套工具系统暴露给外部 AI Agent 的 SKILL.md 方案
- [两阶段生成引擎](两阶段生成引擎.md) —— 工具调用在文档生成阶段的循环
- [语义搜索实现](语义搜索实现.md) —— `semantic_search` 工具的 Embedding 引擎细节