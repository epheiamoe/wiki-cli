现在已有足够的信息来撰写完整的页面。

# LLM 客户端：流式与非流式

`LLMClient` 是 wiki-cli 与 OpenAI 兼容 API 之间的通信层。它封装了两个核心路径：**流式（SSE）** 用于逐 token 输出，**非流式** 用于一次获取完整响应。两者共用同一个请求构建函数、同一个退避重试策略，只在响应处理方式上分岔。

---

## 请求构造：`buildRequest`

无论是 `chatStream` 还是 `chat`，都通过 `buildRequest` 函数组装 HTTP 请求。它的签名决定了所有请求的统一形状：

```typescript
function buildRequest(
  config: WikiCliConfig,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  stream?: boolean,
  jsonMode?: boolean
): { url: string; headers: Record<string, string>; body: string }
```

**URL** 由 `config.baseUrl` 拼接 `/chat/completions` 构成，末尾多余的斜杠会被 `replace(/\/+$/, '')` 去除。[来源](src/ai/llm-client.ts#L49-L49)

**Headers** 固定两个字段：

- `Content-Type: application/json`
- `Authorization: Bearer ${config.apiKey}`

[来源](src/ai/llm-client.ts#L62-L65)

**Body** 的组装分三步：

1. **基础字段**：`model` 取自配置，`messages` 经过 `serializeMessage` 逐一转换。
2. **条件字段**：`stream` 为 true 时添加 `stream: true`；`tools` 非空时附上 `tools` 数组；`jsonMode` 启用则设置 `response_format: { type: 'json_object' }`。
3. **整体序列化**：`JSON.stringify(body)`。

[来源](src/ai/llm-client.ts#L50-L60)

### `serializeMessage`：消息的精确序列化

`serializeMessage` 负责将 `ChatMessage` 转换为 API 可接受的 JSON 对象。它保留 `role`、`content`、`reasoning_content`、`tool_calls`、`tool_call_id`、`name` 六个字段，但在 `content === null` 时显式删除该字段（部分模型不允许 `"content": null`）。特别地，`reasoning_content` 只有在非 null 且非 undefined 时才会写入，使得深度思考模型的思维链可以正常传递。[来源](src/ai/llm-client.ts#L31-L42)

---

## 流式：`chatStream`

`chatStream` 是一个 `AsyncGenerator<StreamChunk>`，它通过 **SSE（Server-Sent Events）** 协议逐段消费 LLM 的输出。方法签名如下：

```typescript
async *chatStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  jsonMode?: boolean
): AsyncGenerator<StreamChunk>
```

[来源](src/ai/llm-client.ts#L91-L93)

### SSE 行解析管道

收到 HTTP 响应后，代码通过 `ReadableStream.getReader()` 获取底层字节流，用 `TextDecoder` 解码后拼接入 `buffer`，然后按 `\n` 切行：

```
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop() || '';
```

[来源](src/ai/llm-client.ts#L122-L124)

对每一行，经过三重过滤进入解析逻辑：

1. **空白忽略**：`trimmed` 后为空则跳过。
2. **SSE 前缀剥离**：只有以 `data: ` 开头的行才进入后续处理，前缀被 `trimmed.slice(6)` 去掉。
3. **[DONE] 终结信号**：若剥离后的内容等于 `[DONE]`，则 yield `{ type: 'done' }` 并 return。[来源](src/ai/llm-client.ts#L127-L131)

### delta 分发

剥离前缀后的数据经过 `JSON.parse` 解析，提取 `choices[0].delta`。根据 delta 中的字段，yield 三种类型的 chunk：

| Chunk 类型 | 触发字段 | yiled 内容 |
|---|---|---|
| `content` | `delta.content` | 增量文本 |
| `reasoning` | `delta.reasoning_content` | 思维链文本 |
| `tool_call` | `delta.tool_calls` | 完整的 `ToolCall` 对象 |

[来源](src/ai/llm-client.ts#L133-L152)

`tool_calls` 的处理需要留意：delta 中的每个 `tool_call` 被重构为 `ToolCall` 接口，包含 `id`、`index`、`type` 和 `function`（name + arguments）。这里不做流式拼合——每个 delta 片段作为一个独立的 chunk 输出，由调用方自行累加。[来源](src/ai/llm-client.ts#L140-L152)

### 流中的重试反馈

在流式模式下，每次重试前会 yield 一个 `type: 'reasoning'` 的 chunk，内容为 `[retry N/3 in Xms]`，让下游有机会将重试信息展示给用户。[来源](src/ai/llm-client.ts#L98-L101)

---

## 非流式：`chat`

`chat` 返回一个 `Promise<LLMResponse>`，适用于不需要逐 token 展示的场景。签名如下：

```typescript
async chat(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  jsonMode?: boolean
): Promise<LLMResponse>
```

[来源](src/ai/llm-client.ts#L181-L183)

它与 `chatStream` 的区别仅在于响应处理：

1. `buildRequest` 中 `stream` 参数传 `false`，因此 body 中不包含 `stream: true`。
2. 收到 HTTP 响应后，直接 `response.json()` 获取完整 JSON。
3. 从 `result.choices[0].message` 中提取 `content`、`reasoning_content` 和 `tool_calls`，封装为 `LLMResponse` 返回。[来源](src/ai/llm-client.ts#L199-L210)

**错误处理方式不同**：非流式遇到不可重试的错误（如 401）会直接 `throw` 异常，而流式会 yield `{ type: 'error', error: ... }`。[来源](src/ai/llm-client.ts#L205-L206)

---

## 退避重试策略

两种模式共享同一个重试引擎，核心参数为 `MAX_RETRIES = 3`。[来源](src/ai/llm-client.ts#L28-L28)

### `isRetryable` 判定

```typescript
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}
```

[来源](src/ai/llm-client.ts#L68-L70)

- **可重试**：HTTP 5xx（服务端错误）、429（限流）
- **不可重试**：4xx（客户端错误，如 401 未授权、404 不存在）

### 指数退避

每次重试前等待 `2^(attempt - 1) * 1000` 毫秒，即第 1 次重试等待 1 秒，第 2 次 2 秒，第 3 次 4 秒。[来源](src/ai/llm-client.ts#L72-L74)

### 失败场景覆盖

测试覆盖了四种典型场景：

- **流式 5xx 恢复**：第一次返回 502，第二次成功，最终 yield `done`。[来源](tests/llm-client.test.ts#L172-L198)
- **非流式 5xx 恢复**：第一次返回 503，第二次成功，最终 `LLMResponse.content` 为预期值。[来源](tests/llm-client.test.ts#L149-L169)
- **网络错误恢复**：前两次 `ECONNRESET`，第三次成功。[来源](tests/llm-client.test.ts#L200-L215)
- **4xx 不重试**：401 错误立即抛出，fetch 仅调用一次。[来源](tests/llm-client.test.ts#L217-L229)

---

## 接口契约

### `ChatMessage`

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
```

[来源](src/ai/llm-client.ts#L3-L10)

### `StreamChunk`

```typescript
interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call' | 'done' | 'error';
  content?: string;
  reasoning_content?: string;
  tool_call?: ToolCall;
  error?: string;
}
```

[来源](src/ai/llm-client.ts#L20-L26)

五种 type 对应流式生命周期的全部状态：增量文本（`content`）、思维链（`reasoning`）、工具调用（`tool_call`）、完成（`done`）、错误（`error`）。

### `LLMResponse`

```typescript
interface LLMResponse {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls: ToolCall[];
}
```

[来源](src/ai/llm-client.ts#L28-L32)

非流式的完整响应，`tool_calls` 始终存在，可为空数组。

---

## 设计要点

1. **职责分离**：`buildRequest` 只组装请求，不关心是否流式；`chatStream` 与 `chat` 只处理响应体，不重复组装逻辑。
2. **SSE 容忍性**：缓冲区行解析容忍任意字节边界切割，即使一行数据跨多个 `reader.read()` 调用也能正确拼接。[来源](src/ai/llm-client.ts#L122-L126)
3. **失败隔离**：流式读取过程中抛出的异常（如连接中断）会被捕获并进入重试循环，不会直接崩溃。[来源](src/ai/llm-client.ts#L155-L157)
4. **泛化设计**：通过配置中的 `baseUrl` 和 `apiKey`，`LLMClient` 可对接任意 OpenAI 兼容 API，不绑定特定厂商。参见 [自定义 LLM 与 Embedding](自定义-llm-与-embedding.md) 了解扩展方式。

---

## 与系统的集成

`LLMClient` 是 wiki-cli 生成和问答流程的底层引擎：

- **Wiki 生成**：[两阶段生成引擎](两阶段生成引擎.md) 在撰写页面时调用 `chat` 方法，配合 `jsonMode` 获取结构化的 JSON 输出。
- **AI 问答**：[AI 问答](ai-问答.md) 命令使用 `chatStream` 实现终端流的实时输出。
- **浏览器聊天**：[AI 聊天面板](ai-聊天面板-浏览器内对话.md) 同样依赖 `chatStream` 实现 SSE 流式通信。
- **工具调用**：`chat` 和 `chatStream` 均接受 `tools` 参数，集成 [Tool 系统](tool-系统-定义与执行.md) 的 13 个只读工具，使 LLM 可直接查询仓库状态。