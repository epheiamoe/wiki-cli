# LLM 客户端核心实现

`LLMClient` 是对 OpenAI 兼容 API 的一层薄封装，职责边界清晰：接受配置与消息数组，输出流式或非流式的 LLM 响应。它不处理对话管理、不缓存历史、不解析工具执行结果——这些由上层 [`AI 会话管理层`](ai-问答交互.md) 和 [`工具调用系统`](工具调用系统.md) 完成。

## 构造函数：依赖注入配置

构造函数只做一件事：将 `WikiCliConfig` 对象持有在私有字段中。

```ts
export class LLMClient {
  private config: WikiCliConfig;
  constructor(config: WikiCliConfig) {
    this.config = config;
  }
```

`WikiCliConfig` 包含 `baseUrl`、`model`、`apiKey` 等连接必需字段[来源](../src/config/config-store.ts#L8-L14)。这种注入方式使客户端与配置来源解耦——无论是从 `~/.wiki-cli/config.json` 加载还是环境变量传入，对 `LLMClient` 透明。单元测试也可直接传入 mock 配置，无需触碰文件系统。

## 请求组装：`buildRequest` 函数

`buildRequest` 是 `LLMClient` 文件中唯一的**纯函数**（无副作用、不访问 `this`），负责将配置和参数序列化为 `fetch` 需要的 `{ url, headers, body }` 三元组[来源](../src/ai/llm-client.ts#L56-L74)。

### URL 拼接

```ts
const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
```

先去除 `baseUrl` 尾部斜杠，再追加 `/chat/completions`。这是 OpenAI 兼容端点惯例，使得用户配置时只需填写 `https://api.openai.com/v1` 这类基础地址。

### 请求体组装逻辑

| 条件 | 字段 | 说明 |
|---|---|---|
| 始终设置 | `model`, `messages` | `messages` 经 `serializeMessage` 逐条处理 |
| `stream === true` | `stream: true` | 启用 SSE 流式响应 |
| `tools` 非空数组 | `tools` | 传入完整 `ToolDefinition[]` |
| `jsonMode === true` | `response_format: { type: "json_object" }` | 强制模型输出合法 JSON |

这四项在 `body` 对象上通过条件赋值叠加，而非每次都重建整个结构体。代码中用 `if` 逐个检查，清晰可读[来源](../src/ai/llm-client.ts#L61-L68)。

## 消息序列化：`serializeMessage` 的边界策略

```ts
function serializeMessage(m: ChatMessage): Record<string, any>
```

这是典型的白名单序列化：只保留 `role`、`content`、`reasoning_content`、`tool_calls`、`tool_call_id`、`name` 六个字段[来源](../src/ai/llm-client.ts#L29-L39)。关键边界处理：

- **`content === null`**：显式 `delete msg.content`，而非设为 `null`。某些 API 对 `"content": null` 会报错，删除后字段完全消失则无此问题。
- **`reasoning_content`**：仅在非 `undefined` 且非 `null` 时写入，兼容不含推理内容的模型。
- **`tool_calls`**：直接透传 `ToolCall[]`，不做深层拷贝。

这种策略保证了与不同类型提供商的兼容性——DeepSeek、OpenAI、Mistral 等在消息格式上存在细微差异，序列化层做了统一消歧。

## 两种调用路径

### `chatStream`: AsyncGenerator 流式通信

返回 `AsyncGenerator<StreamChunk>`，通过 `yield` 逐块吐出内容。调用方可 `for await...of` 消费[来源](../src/ai/llm-client.ts#L84-L172)。

```
[content: "..."] → [reasoning: "..."] → [tool_call: {...}] → [done]
```

流式解析的核心是 SSE 行解析循环（详见 [`流式通信与 SSE 解析`](流式通信与-sse-解析.md)）：

```
buffer += decoder.decode(value, { stream: true })
lines = buffer.split('\n')
```

每次读取后按换行符切分，保留未完成行在 `buffer` 中供下次拼接。这处理了 `data:` 行可能跨 chunk 边界的问题。

对 `data: [DONE]` 直接 `yield { type: 'done' }` + `return` 终止生成器。

### `chat`: Promise 非流式通信

返回 `Promise<LLMResponse>`，内部结构为[来源](../src/ai/llm-client.ts#L174-L216)：

```ts
{
  content: string | null,
  reasoning_content?: string | null,
  tool_calls: ToolCall[]
}
```

解析 `response.json()` 后从 `choices[0].message` 提取三个字段。与流式路径共享同一 `buildRequest` 函数，仅 `stream` 参数不同。

## 重试策略：指数退避

两条路径共享同一重试逻辑模板，差异仅在错误传导方式上。

```
MAX_RETRIES = 3
attempt 0 → attempt 1 → attempt 2 → attempt 3 (共 4 次尝试)
                    ↑ 退避 delay = 2^(attempt-1) * 1000ms
                    ↑                = 1000ms → 2000ms → 4000ms
```

**流式路径**用 `yield { type: 'reasoning' }` 将重试通知注入流，最终在耗尽重试次数后 `yield { type: 'error' }`，由消费者决定如何处理[来源](../src/ai/llm-client.ts#L93-L96)。

**非流式路径**直接抛出异常，由调用方 try/catch 兜底[来源](../src/ai/llm-client.ts#L197-L206)。

### `isRetryable` 判定

```ts
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}
```

- **5xx**：服务端内部错误，可能暂时可重试。
- **429**：速率限制，退避后通常可恢复。
- **4xx（除429外）**：如 400（请求格式错误）、401（认证失败）、404（端点不存在），一律不重试，直接报错。

## 设计评价

`LLMClient` 是典型的**策略模式**实现——上层通过 `chat`/`chatStream` 两种策略访问同一底层 API。它的核心价值不在功能丰富，而在**边界处理**的严谨性：序列化时的 null 清理、SSE 解析的行缓冲、重试的退避与可重试性分类。这些细节正是与生产级 API 对接时最容易出错的环节。

## 相关页面

- [`流式通信与 SSE 解析`](流式通信与-sse-解析.md) — 深入分析 SSE 行解析与多轮工具调用时的流处理
- [`工具调用系统`](工具调用系统.md) — `ToolDefinition` 的定义与工具执行引擎
- [`配置存储与模型清单`](配置存储与模型清单.md) — `WikiCliConfig` 的持久化机制
- [`AI 问答交互`](ai-问答交互.md) — `LLMClient` 在交互式对话中的使用场景