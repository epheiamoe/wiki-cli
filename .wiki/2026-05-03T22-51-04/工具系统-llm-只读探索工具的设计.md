# 工具系统：LLM 只读探索工具的设计

赋予 LLM 以代码库的"眼睛"——这正是工具系统的核心使命。在 `wiki-cli ai` 命令的交互流程中，LLM 本身对用户的文件系统一无所知，而工具系统则充当着代理层，将文件系统的读取能力封装为 LLM 可以调用的 **函数**。本文从接口契约、路由调度、递归实现三个层面剖析这套设计。

## 工具全景：10 个只读函数

所有工具均为"只读"——不产生任何写操作。这是安全的第一道防线：LLM 可以探索代码库，但无法修改它。

| 分类 | 工具名 | 参数 | 返回值 | 用途 |
|------|--------|------|--------|------|
| **文件系统** | `list_directory` | `dir_path`(必填), `max_depth`(可选) | 嵌套树结构 | 查看目录拓扑 |
| | `list_files` | `path`(必填), `extensions`(可选) | 扁平文件列表 | 按扩展名筛选文件 |
| | `read_file` | `file_path`(必填), `start_line`, `end_line`(可选) | 文件文本内容 | 按行范围读取文件 |
| | `search_in_files` | `path`(必填), `pattern`(必填), `extensions`(可选) | 匹配行数组 `{file,line,content}` | 正则搜索代码 |
| **Git** | `git_log` | `max_count`(可选), `path`(可选) | Git 日志文本 | 查看提交历史 |
| | `git_show` | `object`(必填), `path`(可选) | 对象内容文本 | 查看某个 commit/tree/blob |
| | `git_remote_info` | 无 | 远程仓库列表 | 查看 remote 配置 |
| **环境** | `dotenv_template` | 无 | `.env.example` 内容 | 检查环境变量模板 |
| **Wiki** | `list_wiki_pages` | 无 | 页面列表 | 列举所有已生成的 Wiki 页面 |
| | `read_wiki` | `slug`(必填) | 页面 Markdown | 按 slug 读取 Wiki 页面 |

全部定义于 `toolDefinitions` 数组中，总计 **10 个工具**。[来源](src/ai/tools.ts#L16-L120)

---

## 接口契约：ToolDefinition 与 OpenAI function calling

工具系统的核心接口 `ToolDefinition` 直接映射到 OpenAI 的 **function calling** 标准：

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

[来源](src/ai/tools.ts#L10-L15)

### 三层结构的含义

| 层级 | 对应字段 | 语义 |
|------|---------|------|
| 工具外壳 | `type: 'function'` | 固定值，OpenAI API 要求 |
| 函数描述 | `function.name` | LLM 选择工具时的唯一标识符 |
| | `function.description` | LLM 理解何时调用此工具的语义提示 |
| 参数模式 | `function.parameters.type: 'object'` | JSON Schema 风格，描述参数的形状 |
| | `properties` | 每个参数的类型、描述、是否可空 |
| | `required` | 必填参数列表 |

关键在于 **`parameters` 是 `Record<string, any>`**——这并非严格的 JSON Schema 类型约束，而是将模式定义的责任交给了开发者。在每个工具定义中，实际上都遵循了 JSON Schema 的约定（`type: 'object'` + `properties` + `required`），但 TypeScript 类型层面没有强制校验。这种"约定而非强制"的设计简化了类型系统，前提是开发者必须自律。

### 两种参数模式

观察参数结构会发现两种模式：

1. **有参数工具**（8 个）：如 `read_file` 需要 `file_path`，LLM 必须先规划好参数再调用。
2. **无参数工具**（2 个）：`git_remote_info` 和 `dotenv_template` 的 `required: []`、`properties: {}`，LLM 随时可调用。

```typescript
// 有参数示例
{ name: 'read_file', parameters: { required: ['file_path'], properties: { ... } } }

// 无参数示例
{ name: 'git_remote_info', parameters: { required: [], properties: {} } }
```

[来源](src/ai/tools.ts#L16-L120)

### 在 LLM 请求中的位置

在 `LLMClient` 中，工具定义通过 `buildRequest` 函数被嵌入 API 请求体：

```typescript
if (tools && tools.length > 0) body.tools = tools;
```

这一行将整个 `toolDefinitions` 数组作为 `tools` 字段传给 OpenAI 兼容 API。LLM 在生成响应时，如果判断需要执行文件操作，会返回 `tool_calls` 数组，其中每个元素包含 `function.name` 和 `function.arguments`（JSON 字符串）。[来源](src/ai/llm-client.ts#L68-L72)

---

## 路由调度：toolHandlers 与 executeToolCall

工具系统的调度采用**直路由模式**——一个名字到处理函数的简单映射：

```typescript
const toolHandlers: Record<string, (args: any) => Promise<ToolResult>> = {
  list_directory: (args) => listDirectory(args.dir_path, args.max_depth),
  list_files:     (args) => listFiles(args.path, args.extensions),
  read_file:      (args) => readFileTool(args.file_path, args.start_line, args.end_line),
  search_in_files:(args) => searchInFiles(args.path, args.pattern, args.extensions),
  git_log:        (args) => gitLog(args.max_count, args.path),
  git_show:       (args) => gitShow(args.object, args.path),
  git_remote_info:()    => gitRemoteInfo(),
  dotenv_template:()    => dotenvTemplate(),
  list_wiki_pages:()    => listWikiPages(),
  read_wiki:      (args) => readWiki(args.slug)
};
```

[来源](src/ai/tools.ts#L270-L283)

### 执行器函数

```typescript
export async function executeToolCall(name: string, args: any): Promise<ToolResult> {
  const handler = toolHandlers[name];
  if (!handler) {
    return { type: 'error', data: `Unknown tool: ${name}` };
  }
  return handler(args);
}
```

[来源](src/ai/tools.ts#L285-L292)

调度逻辑只有三件事：
1. **查找**：以 `name` 为键从 `toolHandlers` 中检索处理器
2. **守卫**：未找到时返回 `{ type: 'error', data: 'Unknown tool: ...' }`，而非抛出异常
3. **分发**：将 `args` 原样传递给处理器

### 统一返回值契约

每个处理器的返回值都遵循 `ToolResult` 接口：

```typescript
export interface ToolResult {
  type: 'success' | 'error';
  data: any;
}
```

[来源](src/ai/tools.ts#L5-L8)

这保证了 LLM 收到的工具响应是一个可预测的结构——无论是成功数据还是错误消息，都包裹在 `{ type, data }` 中。在 `src/commands/ai.ts` 中，工具调用的结果被序列化为 JSON 字符串加入对话上下文：

```typescript
const result = await executeToolCall(tc.function.name, args);
messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result) });
```

[来源](src/commands/ai.ts#L169-L170)

### 条件注册策略

一个值得注意的设计点是：Wiki 工具不是始终可用的。在 `aiCommand` 入口处，代码会检测当前工作目录是否包含 `.wiki/` 文档：

```typescript
const allToolDefs = hasWiki ? toolDefinitions : toolDefinitions.filter(t =>
  t.function.name !== 'list_wiki_pages' && t.function.name !== 'read_wiki'
);
```

[来源](src/commands/ai.ts#L107-L110)

LLM 的"能力边界"在运行时动态调整——没有 Wiki 时，LLM 甚至不知道 Wiki 工具的存在，避免了无效调用。这也是为什么工具注册是数据驱动的（`toolDefinitions` 数组）而非硬编码的条件分支。

---

## 递归实现：三个深度遍历算法

文件系统工具中最具技术含量的部分是三个递归遍历函数，它们分别服务于 `list_directory`、`list_files` 和 `search_in_files`。

### 1. buildTree：目录拓扑生成

```typescript
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
```

[来源](src/ai/tools.ts#L141-L157)

关键设计决策：

- **深度截断**：当 `depth > maxDepth` 时返回 `{ name: '...', type: 'truncated' }`，而非返回空数组。这让 LLM 能感知到"这里还有内容但被截断了"，从而触发下一步精确探索。
- **路径相对化**：`relative(root, current)` 使树结构的根节点始终为 `.`，下层节点为相对路径，减少 token 消耗。
- **忽略规则**：跳过 `.` 开头和 `node_modules`，这是代码探索的常识性过滤。
- **默认深度 3**：`maxDepth ?? 3` 防止意外传入 undefined 导致无限递归。[来源](src/ai/tools.ts#L136)

### 2. collectFiles：扁平文件收集

```typescript
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
```

[来源](src/ai/tools.ts#L168-L180)

与 `buildTree` 的不同之处：
- **扁平输出**：不构建嵌套结构，而是将匹配的文件路径追加到 `result` 数组
- **后缀过滤**：`extensions.includes(extname(item.name))` 实现扩展名白名单过滤
- **空扩展名列表 = 不过滤**：`!extensions || extensions.length === 0` 时收集所有文件

### 3. searchInDir：内容级搜索

```typescript
async function searchInDir(root: string, dir: string, regex: RegExp, extensions: string[] | undefined,
  results: { file: string; line: number; content: string }[]): Promise<void> {
  // ... 遍历文件 ...
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      results.push({ file: relative(root, fullPath), line: i + 1, content: lines[i].trim() });
    }
  }
}
```

[来源](src/ai/tools.ts#L203-L217)

与前两者的关键区别：
- **逐行匹配**：读取文件内容后按行分割，逐行应用正则
- **结果结构**：每条匹配包含 `file`（相对路径）、`line`（1-indexed）、`content`（trimmed）
- **大小写不敏感**：`new RegExp(pattern, 'i')` 默认忽略大小写
- **异常容忍**：不可读文件被 `try/catch` 静默跳过，不中断整个搜索

### 三个递归的共同约束

| 特性 | 实现方式 |
|------|---------|
| 隐藏文件跳过 | `item.name.startsWith('.')` |
| node_modules 跳过 | `item.name === 'node_modules'` |
| 异步并发 | `for...of` 串行 + `await`，避免单目录下大量并发 fd |
| 路径解析 | `resolve()` 转绝对路径 + `existsSync()` 前置校验 |

---

## 调度时序：从 LLM 到工具处理器

完整的调用链可以概括为：

```
LLM ← → chatStream() / chat() ← → buildRequest(tools=toolDefinitions)
                                      ↓ (LLM 返回 tool_calls)
                                   executeToolCall(name, args)
                                      ↓
                                   toolHandlers[name](args)
                                      ↓
                                   { type: 'success' | 'error', data }
                                      ↓
                                   JSON.stringify → role: 'tool' 消息
                                      ↓
                                   加入 messages 数组，继续下一轮迭代
```

[来源](src/commands/ai.ts#L155-L176)

这是一个 **工具循环（tool loop）**——LLM 的每次响应要么产生文本答案（结束），要么产生工具调用（继续）。最大迭代次数为 50，防止无限循环。[来源](src/commands/ai.ts#L124)

---

## 与相关模块的协作

- 工具定义流向 [LLM 客户端：流式通信与重试机制](llm-客户端-流式通信与重试机制.md) 的 `buildRequest` 和流式解析逻辑。
- `executeToolCall` 在 [AI 交互命令：wiki-cli ai](ai-交互命令-wiki-cli-ai.md) 的 `chatOnce` 和 `answerOnly` 中被调用，驱动多轮工具循环。
- Wiki 工具（`list_wiki_pages` / `read_wiki`）与 [生成管线：从大纲到页面的完整流程](生成管线-从大纲到页面的完整流程.md) 产出的 `.wiki/` 目录结构紧密耦合。
- 测试覆盖参见 [测试策略与 Vitest 配置](测试策略与-vitest-配置.md) 中 `tests/tools.test.ts` 的 20+ 个测试用例。[来源](tests/tools.test.ts#L1-L140)