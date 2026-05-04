# LLM 客户端设计

`src/ai/llm-client.ts` 是一个面向 OpenAI 兼容 API 的 HTTP 客户端封装层。它处理两个核心职责：**请求构建**——将应用层数据类型序列化为 API 可接受的 JSON 格式；**响应解析**——从 SSE（Server-Sent Events）流或同步 JSON 响应中提取结构化结果。设计上围绕 `LLMClient` 类展开，暴露两个公共方法：`chatStream`（异步生成器）和 `chat`（Promise）。

---

## 类型系统：`LLMResponse` 与 `StreamChunk`

客户端定义了三个核心接口，构成整个模块的数据契约。

### `ChatMessage`：对话消息的通用表示

消息可以有 `system`、`user`、`assistant`、`tool` 四种角色。除了标准的 `content` 字段外，还包含三个可选字段：

- `reasoning_content` —— 推理链文本，兼容 DeepSeek 等提供商的 CoT（Chain-of-Thought）输出
- `tool_calls` —— 函数调用列表，用于流式/final 消息中的工具调用
- `tool_call_id` / `name` —— 工具响应消息的关联 ID 和函数名

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
```
[来源](src/ai/llm-client.ts#L3-L11)

### `ToolCall`：函数调用的描述

每个工具调用包含唯一 `id`、流式排序用的 `index`、固定类型 `'function'`，以及函数名和 JSON 参数字符串：

```typescript
export interface ToolCall {
  id: string;
  index?: number;
  type: 'function';
  function: { name: string; arguments: string; };
}
```
[来源](src/ai/llm-client.ts#L13-L21)

### `LLMResponse`：非流式响应的最终结果

`chat` 方法返回该类型，包含 `content`、`reasoning_content` 和 `tool_calls` 三个字段：

```typescript
export interface LLMResponse {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls: ToolCall[];
}
```
[来源](src/ai/llm-client.ts#L30-L34)

### `StreamChunk`：流式事件的分段单元

通过 `type` 字段区分五种事件类型——`content`（文本增量）、`reasoning`（推理链增量）、`tool_call`（工具调用片段）、`done`（流结束）、`error`（错误终止）。调用者可通过 `switch` 或 `if` 分支处理不同类型：

```typescript
export interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call' | 'done' | 'error';
  content?: string;
  reasoning_content?: string;
  tool_call?: ToolCall;
  error?: string;
}
```
[来源](src/ai/llm-client.ts#L23-L28)

---

## 请求构建：`buildRequest`

`buildRequest` 是一个纯函数（非导出），负责将内部类型转换为 fetch API 所需的 `{ url, headers, body }` 三元组。

### URL 组装

```typescript
const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
```

尾部斜杠被擦除后拼接 `/chat/completions` 路径。

### Body 序列化

```typescript
const body: Record<string, any> = {
  model: config.model,
  messages: messages.map(serializeMessage),
};
```

三个可选开关通过条件注入：

| 参数 | 条件 | body 字段 |
|------|------|-----------|
| `stream` | `true` | `{ stream: true }` |
| `tools` | 非空数组 | `{ tools: [...ToolDefinition[]] }` |
| `jsonMode` | `true` | `{ response_format: { type: 'json_object' } }` |

`jsonMode` 通过在请求体中设置 `response_format: { type: 'json_object' }` 实现，这指示 OpenAI 兼容 API 强制输出合法 JSON。该功能在 outline 生成阶段使用，通过 `[配置LLM](配置llm.md)` 中的 `jsonMode` 配置项开启。[来源](src/ai/llm-client.ts#L70-L83)

### Header 构造

Authorization header 使用 Bearer Token 格式，`apiKey` 来自 `WikiCliConfig`。[来源](src/ai/llm-client.ts#L85-L89)

---

## 消息序列化：`serializeMessage`

`serializeMessage` 将 `ChatMessage` 转换为 API 接收的扁平的 `Record<string, any>`。它的关键行为：

1. **`reasoning_content` 有条件保留**：仅当非 `undefined` 且非 `null` 时才写入。这使得普通模型（不返回推理内容）的消息不会附带该字段。
2. **`content` 可为 `null`**：当消息只有 `tool_calls` 没有文本内容时（如 API 的纯函数调用响应），`content` 显式设为 `null` 然后被 `delete` —— 因为某些 API 对 `content: null` 敏感，删掉该键更安全。
3. **`tool_calls` 和 `tool_call_id`/`name`**：分别对应 assistant 的 function call 消息和 tool 的响应消息。

```typescript
function serializeMessage(m: ChatMessage): Record<string, any> {
  const msg: Record<string, any> = { role: m.role };
  if (m.content !== undefined) msg.content = m.content;
  if (m.reasoning_content !== undefined && m.reasoning_content !== null) {
    msg.reasoning_content = m.reasoning_content;
  }
  if (m.tool_calls) msg.tool_calls = m.tool_calls;
  if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
  if (m.name) msg.name = m.name;
  if (msg.content === null) delete msg.content;
  return msg;
}
```
[来源](src/ai/llm-client.ts#L43-L55)

---

## `chatStream`：SSE 流式解析状态机

`chatStream` 是一个 `AsyncGenerator<StreamChunk>`，实现逐行解析 SSE 数据流。

### 外部重试循环

方法外层包裹了一个 **指数退避重试** 循环（最多 `MAX_RETRIES + 1 = 4` 次尝试）。每次重试前向调用者 yield 一个 `reasoning` 类型的事件，提供客户端可见的重试提示：

```typescript
yield { type: 'reasoning', reasoning_content: `\n[retry ${attempt}/${MAX_RETRIES} in ${wait}ms]` };
```
[来源](src/ai/llm-client.ts#L116-L118)

### 缓冲区解析状态机

核心解析逻辑是一个两阶段状态机：

```
[原始字节] → TextDecoder → buffer (行拼接) → split('\n') → 逐行处理
```

1. **行缓冲**：`buffer` 变量累积残缺行，`split('\n')` 获取完整行后，最后一段重新放回 `buffer`。
2. **SSE 行过滤**：跳过空行和非 `data: ` 前缀的行。
3. **[DONE] 终结**：`data: [DONE]` 产生 `{ type: 'done' }` 并 return。
4. **JSON 解析**：对 `data: ` 后的内容执行 `JSON.parse`。

```typescript
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop() || '';
```
[来源](src/ai/llm-client.ts#L148-L158)

### Delta 字段提取

每个 SSE event 解析后，从 `parsed.choices[0].delta` 中提取三个类型的增量：

| Delta 字段 | 产出 StreamChunk |
|-----------|-----------------|
| `content` | `{ type: 'content', content: delta.content }` |
| `reasoning_content` | `{ type: 'reasoning', reasoning_content: ... }` |
| `tool_calls` | 遍历每个工具调用，组装 `ToolCall` 对象后 yield `{ type: 'tool_call', tool_call }` |

**工具调用的特殊性**：流式 API 中同一个工具调用的 `name` 和 `arguments` 可能分多次 delta 传来。客户端的策略是每次 delta 到达即独立 yield 一个 chunk，由上层（如 `[AI会话管理系统](ai会话管理系统.md)`）负责按 `index` 累加合并。[来源](src/ai/llm-client.ts#L161-L189)

### 流读取错误处理

如果 `reader.read()` 抛出异常（如网络闪断），外层 `try/catch` 捕获后将 `lastError` 设值后 `continue` 进入重试循环，而非直接终止整个流。[来源](src/ai/llm-client.ts#L191-L194)

---

## `chat`：同步请求与自动重试

### 请求模式

`chat` 调用 `buildRequest` 时 `stream` 设为 `false`，body 中不含 `stream` 字段，API 行为为同步返回完整 JSON。

### 响应解析

```typescript
const result = await response.json();
const choice = result.choices?.[0]?.message;
return {
  content: choice?.content || null,
  reasoning_content: choice?.reasoning_content || null,
  tool_calls: choice?.tool_calls || [],
};
```
[来源](src/ai/llm-client.ts#L232-L237)

### 重试策略

与流式版本共享同一个 `isRetryable` 判断和指数退避逻辑：

```typescript
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}
```
[来源](src/ai/llm-client.ts#L93-L95)

**可重试条件**：HTTP 429（Rate Limit）和所有 5xx 服务端错误。4xx（如 400、401、403）视为不可恢复，直接抛出。

**指数退避**：第 `attempt` 次重试的等待时间为 `Math.pow(2, attempt - 1) * 1000` 毫秒，即 1s → 2s → 4s。[来源](src/ai/llm-client.ts#L97-L99)

**差异点**：`chat` 方法在最终失败时 `throw` 错误，而 `chatStream` 通过 `yield { type: 'error' }` 传递错误。这反映了二者消费方式的不同——同步调用者期待异常传播，流式调用者期待事件化的错误通知。

---

## `stripCodeFence`：代码块清理工具

这是一个导出工具函数，用于移除 markdown 代码围栏：

```typescript
export function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/g, '').trim();
}
```

它同时处理开头的 ` ```json ` 和结尾的 ` ``` `，这在 LLM 返回被 markdown 包裹的 JSON 时非常有用。[来源](src/ai/llm-client.ts#L57-L59)

---

## 架构关系

```mermaid
classDiagram
    class LLMClient {
        +chatStream(messages, tools?, jsonMode?) AsyncGenerator~StreamChunk~
        +chat(messages, tools?, jsonMode?) Promise~LLMResponse~
        -config WikiCliConfig
    }
    class buildRequest {
        +static call(config, messages, tools?, stream?, jsonMode?) -> { url, headers, body }
    }
    class serializeMessage {
        +static call(ChatMessage) -> Record~string, any~
    }
    class WikiCliConfig {
        +baseUrl string
        +model string
        +apiKey string
        +jsonMode? boolean
    }
    LLMClient --> buildRequest : delegates
    buildRequest --> serializeMessage : uses
    buildRequest --> WikiCliConfig : reads
    LLMClient ..> StreamChunk : yields
    LLMClient ..> LLMResponse : returns
```

---

## 边界情况与设计决策

| 场景 | 处理方式 |
|------|---------|
| `content` 为 `null` | `serializeMessage` 中 `delete msg.content`，避免 API 拒绝含 `null` 的请求 |
| `reasoning_content` 为空字符串 | 仅当 `!== null` 时才序列化，空字符串允许通过（部分 API 需要该字段存在以维持 CoT 上下文） |
| SSE 行不完整 | buffer 累积机制确保跨 chunk 的 JSON 行正确拼接 |
| SSE 中畸形 JSON | `try/catch` 静默跳过，不终止流 |
| API 返回非 JSON | `response.json()` 抛出，被 `catch` 捕获后进入重试 |
| 网络层错误（ECONNRESET） | 外层 `fetch` 的 catch 捕获，`continue` 重试 |
| 流中途断开 | `reader.read()` 的 catch 捕获，`continue` 重试 |
| 工具调用的参数过大 | 分多次 delta 传输，由上层按 `index` 合并 |

---

## 推荐阅读

- [AI代码问答](ai代码问答.md) 展示了 `chatStream` 在交互式对话中的实际使用
- [工具系统与Function Calling](工具系统与function-calling.md) 说明 `ToolDefinition` 的来源和过滤机制
- [两阶段生成引擎](两阶段生成引擎.md) 中 outline 阶段使用 `jsonMode` 强制 JSON 输出
- [AI会话管理系统](ai会话管理系统.md) 解释 `ChatMessage` 在会话中的持久化和恢复
- [配置LLM](配置llm.md) 描述 `WikiCliConfig` 的交互式配置流程