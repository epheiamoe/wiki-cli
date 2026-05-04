现在我已掌握所有核心代码，开始撰写。

---

# 工具调用与Agent循环

## 问题域：为什么需要工具调用？

LLM 的知识存在静态边界——它无法直接读取用户本地文件系统中的目录结构、文件内容或 Git 历史。若要理解一个陌生的代码仓库，LLM 必须拥有"触手"：一组让它能安全、只读地探索文件系统和 Git 仓库的工具。`wiki-cli` 在 `src/ai/tools.ts` 中定义了 8 个这样的工具，并通过 `collectFullResponse` 构建了一个多轮对话循环，让 LLM 能自主调用工具、观察结果、调整下一步行动，直到产出最终内容。

---

## 工具定义层：8 个可调用工具

工具的描述遵循 OpenAI 的 function calling 协议，以 `ToolDefinition` 接口声明（`src/ai/tools.ts#L9-L15`）：

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

整个工具列表由 `toolDefinitions: ToolDefinition[]` 数组承载（`src/ai/tools.ts#L17-L123`），分为三类：

### 文件系统探查（4个）

| 工具名 | 参数 | 用途 |
|---|---|---|
| `list_directory` | `dir_path`（必填），`max_depth`（可选，默认 3） | 递归获取目录结构树。自动跳过 `.` 开头的隐藏条目和 `node_modules`，深度超过 `max_depth` 时截断为 `{ name: '...', type: 'truncated' }` |
| `list_files` | `path`（必填），`extensions`（可选过滤数组） | 递归列出目录下所有文件的绝对路径。可通过 `extensions` 过滤后缀，如 `[".ts", ".js"]` |
| `read_file` | `file_path`（必填），`start_line`/`end_line`（可选） | 读取文件内容，支持按行范围截取（1-indexed）。对于超大文件，LLM 可以只请求关键片段 |
| `search_in_files` | `path`（必填），`pattern`（必填），`extensions`（可选） | 基于正则表达式的全仓库内容搜索。返回匹配项数组：`{ file, line, content }`，路径已做相对化处理 |

### Git 仓库探查（3个）

| 工具名 | 参数 | 用途 |
|---|---|---|
| `git_log` | `max_count`（可选，默认 20），`path`（可选过滤路径） | 执行 `git log --oneline`，获取提交历史概览。可限定某文件或目录的提交记录 |
| `git_show` | `object`（必填，commit hash / branch / tag），`path`（可选） | 执行 `git show`，查看某次提交的完整 diff 或某对象的文件内容 |
| `git_remote_info` | 无参数 | 执行 `git remote -v`，解析并返回远端仓库的名称、URL 和类型（fetch/push）的数组 |

### 项目配置探查（1个）

| 工具名 | 参数 | 用途 |
|---|---|---|
| `dotenv_template` | 无参数 | 读取工作目录下的 `.env.example` 文件。LLM 通过此工具了解项目所需的环境变量配置 |

所有工具均为**只读**操作——不修改文件系统或 Git 状态。[来源](src/ai/tools.ts#L17-L123)

---

## 执行引擎：executeToolCall 与 toolHandlers 映射表

工具定义（`toolDefinitions`）解决的是"LLM 知道有什么工具可用"，而执行引擎解决的是"LLM 决定调用某个工具后，代码如何响应"。

### 映射表：函数名到实现的路由

```typescript
const toolHandlers: Record<string, (args: any) => Promise<ToolResult>> = {
  list_directory:       (args) => listDirectory(args.dir_path, args.max_depth),
  list_files:           (args) => listFiles(args.path, args.extensions),
  read_file:            (args) => readFileTool(args.file_path, args.start_line, args.end_line),
  search_in_files:      (args) => searchInFiles(args.path, args.pattern, args.extensions),
  git_log:              (args) => gitLog(args.max_count, args.path),
  git_show:             (args) => gitShow(args.object, args.path),
  git_remote_info:      ()    => gitRemoteInfo(),
  dotenv_template:      ()    => dotenvTemplate()
};
```

这是典型的**策略模式**（`src/ai/tools.ts#L306-L316`）：键是工具名，值是异步函数，每个函数内部从参数对象中解构出对应的具名参数，转发给底层的实现函数。

### 分发入口

```typescript
export async function executeToolCall(name: string, args: any): Promise<ToolResult> {
  const handler = toolHandlers[name];
  if (!handler) {
    return { type: 'error', data: `Unknown tool: ${name}` };
  }
  return handler(args);
}
```

调用者只需传入工具名和参数对象，无需关心路由细节。未注册的工具名会返回 `{ type: 'error', data: 'Unknown tool: ...' }`，保证 LLM 总能得到一个结构化的响应。[来源](src/ai/tools.ts#L318-L325)

### 返回值协议

所有工具函数返回统一结构 `ToolResult`（`src/ai/tools.ts#L4-L7`）：

```typescript
export interface ToolResult {
  type: 'success' | 'error';
  data: any;
}
```

`type` 字段让 LLM 可快速判断调用是否成功，`data` 携带实际结果或错误消息。调用方（即 Agent 循环）将整个 result 对象 JSON 序列化后注入到消息历史中。

---

## Agent 循环：collectFullResponse 的 30 轮迭代

工具本身只是静态的"能力声明"，真正让 LLM 像**自主 Agent** 一样行动的是 `collectFullResponse` 函数（`src/commands/generate.ts#L182-L274`）。这个函数实现了**ReAct 模式（Reasoning + Acting）** 的核心循环。

### 循环概述

```
LLM 请求 → 解析响应 → 检测 tool_calls
  ├─ 无 tool_calls → 返回最终 content（循环终止）
  └─ 有 tool_calls → 逐一执行 → 结果注入 messages → 继续请求（回到 LLM 请求）
```

最大迭代次数由 `maxToolIterations = 30` 硬编码（`src/commands/generate.ts#L192`）。这意味着 LLM 有 30 次"思考→调用→观察→再思考"的机会。

### 流式与非流式双模式

`collectFullResponse` 接受 `stream: boolean` 参数，两个路径共享同一个循环结构：

**流式路径**——使用 `client.chatStream()`（`src/commands/generate.ts#L201-L233`）：
- 逐 chunk 消费 SSE 流，分离 `content`、`reasoning_content`（用于展示思维链）和 `tool_call`
- 工具调用以流式 delta 到达，通过 `Map<string, ToolCall>` 按 `index` 聚合（因为 OpenAI 协议中流式 tool_calls 的 `arguments` 是按字符分片到达的）
- 一旦流结束，检查是否累积了任何 `tool_call`

**非流式路径**——使用 `client.chat()`（`src/commands/generate.ts#L235-L251`）：
- 单次 HTTP 请求获取完整响应
- `response.tool_calls` 直接包含所有待执行工具调用

两种路径都依赖 [LLM客户端通信协议](llm客户端通信协议.md) 中 `LLMClient` 类的 `buildRequest` 方法将 `toolDefinitions` 注入到 API 请求的 `tools` 字段中。

### 工具结果注入

流式和非流式路径在检测到 `hasToolCalls = true` 后汇合：

```typescript
// 1. 将 assistant 消息（含 tool_calls）推入对话历史
messages.push({
  role: 'assistant',
  content: currentContent || null,
  reasoning_content: currentReasoning || null,
  tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: tc.function })),
});

// 2. 逐一执行工具调用，将结果以 tool role 消息推入
for (const tc of toolCalls) {
  let args: any;
  try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

  logToolCall(tc.function.name, args);
  const result = await executeToolCall(tc.function.name, args);
  logToolResult(tc.function.name, result);

  messages.push({
    role: 'tool',
    tool_call_id: tc.id,
    name: tc.function.name,
    content: JSON.stringify(result),
  });
}
```

关键设计点：
- **参数的 JSON 解析容错**：`try { args = JSON.parse(...) } catch { args = {} }`——LLM 偶尔会生成不完整的 JSON，此时回退为空对象，避免进程崩溃。
- **序列化整个 ToolResult**：包括 `{ type: 'error', data: ... }` 也能被 LLM 理解并调整策略。
- **每条消息携带 `tool_call_id`**：这是 OpenAI 协议的要求，让 API 能将工具结果与对应的调用关联。[来源](src/commands/generate.ts#L256-L271)

### 循环终止条件

两个条件之一满足时循环结束：
1. **LLM 未返回工具调用**：当前迭代的响应中 `hasToolCalls === false`，函数返回 `currentContent`。[来源](src/commands/generate.ts#L253-L258)
2. **达到 30 轮上限**：`while (iteration < maxToolIterations)` 条件失效，返回 `accumulatedContent`（所有轮次累积的文本）或 `null`。[来源](src/commands/generate.ts#L273-L278)

### 可视化流程

```mermaid
flowchart TD
    A[开始: messages=[system, user]] --> B[调用LLM<br>带 toolDefinitions]
    B --> C{响应包含<br>tool_calls?}
    C -->|否| D[返回最终 content<br>→ 循环终止]
    C -->|是| E[将 assistant 消息<br>（含 tool_calls）加入历史]
    E --> F[遍历每个 tool_call]
    F --> G[JSON.parse 参数]
    G --> H[executeToolCall<br>执行具体工具函数]
    H --> I[将 tool 角色结果消息<br>加入历史]
    I --> J{还有 next tool_call?}
    J -->|是| F
    J -->|否| K{iteration < 30?}
    K -->|是| B
    K -->|否| L[返回累积内容或 null]
```

---

## 两个阶段的差异调用

[大纲生成：代码理解与结构化输出](大纲生成-代码理解与结构化输出.md) 和 [页面生成：逐页输出与并行加速](页面生成-逐页输出与并行加速.md) 两个阶段都会调用 `collectFullResponse`，但传参方式不同：

| 阶段 | 调用位置 | stream | jsonMode | 工具用途 |
|---|---|---|---|---|
| 大纲生成 | `generateOutline()` 内循环 | `true` | `config.jsonMode` | 探索目录、读取关键文件、分析 Git 历史，形成仓库全貌 |
| 页面生成 | `generatePages()` → `generateOne()` | `!options.parallel` | 不启用 | 针对性阅读源文件，确保文档准确引用具体代码行 |

大纲阶段的循环由 `maxIterations = 25` 控制（覆盖在 `collectFullResponse` 外层的另一层循环，用于多轮对话以修正 JSON 输出），而页面阶段每个页面的工具调用由 `collectFullResponse` 内部 30 轮控制。[来源](src/commands/generate.ts#L113-L176)

---

## 安全边界与设计原则

所有工具都遵循三条不变规则：

1. **只读性**：不暴露写文件、git commit、修改配置等破坏性操作。
2. **内置限深**：`list_directory` 的 `max_depth` 默认 3，`search_in_files` 和 `collectFiles` 跳过 `.` 前缀和 `node_modules`，防止 LLM 陷入过深的遍历。[来源](src/ai/tools.ts#L78-L82)
3. **错误不崩溃**：每个工具函数都将所有可能的异常捕获为 `{ type: 'error', data: err.message }`。[来源](src/ai/tools.ts#L50-L53)

这种设计让 LLM Agent 可以在一个安全沙箱内反复试错——即便传递了不存在路径或非法的正则表达式，系统也会返回结构化错误而非抛出未捕获异常。

---

## 日志可视化

工具调用执行期间，`logToolCall` 和 `logToolResult` 会被调用（`src/commands/generate.ts#L266-L267`），这些函数来自 [日志与进度显示系统](日志与进度显示系统.md)，在控制台以带颜色的格式实时展示 LLM 调用了哪个工具、传入什么参数、返回了什么结果。这为使用者提供了 Agent 决策过程的可见性。

---

## 推荐阅读

- [LLM客户端通信协议](llm客户端通信协议.md) — 深入工具定义如何通过 `buildRequest` 注入到 API 请求的 `tools` 字段
- [大纲生成：代码理解与结构化输出](大纲生成-代码理解与结构化输出.md) — 工具调用在 Phase 1 中的实际应用场景
- [页面生成：逐页输出与并行加速](页面生成-逐页输出与并行加速.md) — 工具调用在 Phase 2 中的串行/并行模式差异
- [项目结构与模块职责](项目结构与模块职责.md) — `src/ai/tools.ts` 和 `src/commands/generate.ts` 在整体架构中的位置
- [提示词模板引擎](提示词模板引擎.md) — 系统提示词如何引导 LLM 使用工具