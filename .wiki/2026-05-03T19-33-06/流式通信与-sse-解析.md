# 流式通信与 SSE 解析

## 从 HTTP 流到结构化事件

LLM 的流式响应基于 **服务端事件流（Server-Sent Events, SSE）** 协议。当客户端在请求体中设置 `stream: true`，OpenAI 兼容 API 不会等待推理完成，而是将每个 token 的生成结果作为一个独立事件逐行推送给客户端。`chatStream` 方法的全部核心任务就是解析这个事件流，将线性的字节序列还原为语义明确的 **StreamChunk**。

[来源](src/ai/llm-client.ts#L129-L133)

---

## 五层解析管线

SSE 解析器实现在 `chatStream` 方法的内部循环中，一条完整的处理管线如下：

```
字节流 → getReader() → TextDecoder → split('\n') → 过滤 data: → JSON.parse → 提取 delta → yield StreamChunk
```

```mermaid
flowchart LR
    A[HTTP Response Body<br/>ReadableStream] --> B[getReader<br/>逐块读取 Uint8Array]
    B --> C[TextDecoder.decode<br/>stream: true]
    C --> D[buffer += decoded<br/>split by '\\n']
    D --> E{line starts with<br/>'data: '?}
    E -- 否 --> F[跳过]
    E -- 是 --> G[slice(6) 去掉前缀]
    G --> H{data === '[DONE]'?}
    H -- 是 --> I[yield done]
    H -- 否 --> J[JSON.parse]
    J --> K[提取 choices[0].delta]
    K --> L[分发到三种 chunk 类型]
```

### 第一层：逐块读取

```typescript
const reader = response.body?.getReader();
// ...
const { done, value } = await reader.read();
```

使用 `ReadableStream.getReader()` 获取底层读取器。每次 `reader.read()` 返回一个 `Uint8Array` 分块，分块大小由底层网络栈决定，与 LLM 生成 token 的边界**没有对应关系**——一个 token 可能被拆成两半，多个 token 也可能合并到一个分块中。

[来源](src/ai/llm-client.ts#L148-L153)

### 第二层：文本解码

```typescript
const decoder = new TextDecoder();
buffer += decoder.decode(value, { stream: true });
```

`TextDecoder` 的 `stream: true` 模式处理多字节字符在分块边界被截断的情况。解码器内部维护状态，确保断开的 UTF-8 序列能在下一个分块到达时正确拼接。

[来源](src/ai/llm-client.ts#L149-L153)

### 第三层：行分割与缓冲

```typescript
const lines = buffer.split('\n');
buffer = lines.pop() || '';
```

这里有一个精妙的细节：`lines.pop()` 将最后一段**不完整的行**保留回 `buffer` 中，等待下一个字节分块来补全。只有完整行（以 `\n` 结尾）才进入后续解析逻辑。

[来源](src/ai/llm-client.ts#L154-L156)

### 第四层：事件过滤与终止信号

```typescript
if (!trimmed || !trimmed.startsWith('data: ')) continue;
const data = trimmed.slice(6);
if (data === '[DONE]') {
  yield { type: 'done' };
  return;
}
```

去掉 `data: ` 前缀（前 6 个字符）后，检查是否为 `[DONE]` 终止事件。这里 `return` 直接结束生成器，因为 `[DONE]` 之后不会再有任何合法事件。

SSE 协议中 `data: ` 后的空格不是可选——`slice(6)` 同时跳过了 `data:` 后的空格字符。

[来源](src/ai/llm-client.ts#L157-L166)

### 第五层：JSON 解析与 delta 提取

```typescript
const parsed = JSON.parse(data);
const delta = parsed.choices?.[0]?.delta;
```

每个 SSE 事件体都是一个标准 Chat Completions chunk JSON 对象，其结构为：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "content": "北京",
      "reasoning_content": "用户询问...",
      "tool_calls": [...]
    }
  }]
}
```

`delta` 字段携带本次增量信息，可能有多个属性同时出现（如 `tool_calls` 和 `content` 在同一事件中都存在）。

[来源](src/ai/llm-client.ts#L168-L170)

---

## 三种 delta 的分发策略

`delta` 中的三个字段对应三种不同的生成内容，分别映射到 `StreamChunk` 的三种变体：

| delta 字段 | 触发条件 | yield 类型 | 消费者行为 |
|---|---|---|---|
| `delta.content` | `if (delta?.content)` | `{ type: 'content', content }` | 追加到当前消息内容 |
| `delta.reasoning_content` | `if (delta?.reasoning_content)` | `{ type: 'reasoning', reasoning_content }` | 累积推理链 |
| `delta.tool_calls` | `for (const tc of delta.tool_calls)` | `{ type: 'tool_call', tool_call }` | 增量拼接参数 |

每个 `if` 判断都是独立的——一个 SSE 事件可能同时包含 `content` 和 `tool_calls`，三种分支互不排斥。

[来源](src/ai/llm-client.ts#L172-L194)

### reasoning_content 的特殊性

`reasoning_content` 是深度推理模型（如 DeepSeek-R1）特有的字段，携带模型的中间推理过程。它与 `content` 在同一轮响应中互斥出现——推理阶段产出 `reasoning_content`，推理结束后切换到 `content`。消费者端(`ai.ts`、`generate.ts`)通过 `reasoningStarted` 和 `contentStarted` 两个布尔状态来管理显示切换，在终端上表现为先输出灰色推理过程，再输出黑色最终答案。

[来源](src/commands/ai.ts#L149-L161)

---

## `StreamChunk` 联合类型的设计用意

```typescript
export interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call' | 'done' | 'error';
  content?: string;
  reasoning_content?: string;
  tool_call?: ToolCall;
  error?: string;
}
```

这个接口并非真正的 TypeScript 联合类型（discriminated union），而是一个**胖接口**：所有可选字段集中在同一类型上，用 `type` 作为判别式。这种设计的背后有两个原因：

1. **生成器约束**：`AsyncGenerator<StreamChunk>` 要求所有 `yield` 的值类型一致。如果使用真正的联合类型 `AsyncGenerator<ContentChunk | ReasoningChunk | ToolCallChunk | DoneChunk | ErrorChunk>`，消费者的 `for await` 循环每次迭代都需要 `type` 守卫来窄化类型，且生成器方法签名会变得冗长。

2. **消费者模式**：两种消费场景（`ai.ts` 和 `generate.ts`）均使用 `if-else` 链检查 `type` 属性，胖接口使得这串判断更简洁——无需引入 type guard 函数或匹配模式。

代价是运行时没有 TypeScript 的类型安全：消费者仍需防御性检查 `chunk.content ?? ''`。这属于 **API 设计中的实用主义权衡**——在生成器上下文中，运行时判别优于编译期静态联合。

[来源](src/ai/llm-client.ts#L16-L21)

---

## 工具调用的增量参数拼接

这是 SSE 解析中最复杂的逻辑，发生在消费者端（`ai.ts` 和 `generate.ts`），而非 `chatStream` 方法本身。

### 问题：参数跨多个事件

当 LLM 决定调用工具时，`tool_calls` 中的 `function.arguments` 是一个 JSON 字符串（如 `{"dir_path": "/ho"}`），但模型会**逐 token**生成这个字符串。同一个工具调用的参数可能被拆成 10 个以上的 SSE 事件递送：

```json
// 事件 1: tool_calls[0].function.arguments = "{\"dir_path\":"
// 事件 2: tool_calls[0].function.arguments = " \"/ho\""
// 事件 3: tool_calls[0].function.arguments = "me/user\"}"
```

如果简单覆盖，每个事件都会丢失上下文。解法是 **`toolCallsMap`——一个以 index 或 id 为键的累加器**。

### 算法

```typescript
const toolCallsMap = new Map<string, ToolCall>();
// ...
if (chunk.type === 'tool_call' && chunk.tool_call) {
  hasToolCalls = true;
  const tc = chunk.tool_call;
  const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
  if (toolCallsMap.has(key)) {
    const existing = toolCallsMap.get(key)!;
    existing.function.arguments += tc.function.arguments;
    if (tc.id && !existing.id) existing.id = tc.id;
  } else {
    toolCallsMap.set(key, { ...tc });
  }
}
```

**键的生成规则**：优先使用 `index`（OpenAI 流式事件中 tool_calls 不携带 `id`，仅携带 `index` 标识槽位），格式为 `_idx_${tc.index}`；在非流式或某些实现中回退到 `tc.id`。

**增量追加**：当同一个 key 已存在，执行 `existing.function.arguments += tc.function.arguments`——字符串拼接而非覆盖。

**id 补全**：第一个事件可能没有 `id`，后续事件才带上——`tc.id && !existing.id` 这行处理这个序列化差异。

**收尾**：当一轮迭代中不再收到 `tool_call` chunk 时，`toolCallsMap.values()` 就是完整的工具调用集合，可以直接 `JSON.parse` 每个 `arguments`。

[来源](src/commands/generate.ts#L253-L305)

### 多轮工具调用

`generate.ts` 在完成一轮 SSE 解析后，如果 `hasToolCalls === true`，会将完整工具调用结果追加到 `messages` 数组，然后发起新一轮 `chatStream` 请求（`maxToolIterations` 控制最大轮数）。这就是 `StreamChunk.type === 'done'` 事件的作用——它告诉消费者"本轮的 SSE 事件流已全部送达"，消费者检查 `toolCallsMap` 的大小来决定是否进入下一轮迭代。

[来源](src/commands/generate.ts#L310-L340)

---

## 错误处理与重试

`chatStream` 内置了指数退避重试机制，但仅在**可重试状态码**（`status >= 500 || status === 429`）和**网络错误**时触发。4xx 错误（如 401 Unauthorized）直接 `yield { type: 'error' }` 并结束。

流中间如果出现 `reader.read()` 抛出异常（如连接断开），会被 `catch` 块捕获后重试整个请求。但注意：重试时请求体 `bodyStr` 已固定，如果之前消费了部分 SSE 流，重试会导致部分 token 重复。这是 OpenAI 兼容 API 的协议限制——流式请求不支持断点续传。

[来源](src/ai/llm-client.ts#L123-L217)

---

## 设计决策总结

| 决策 | 选择 | 理由 |
|---|---|---|
| 解析粒度 | 行级别 | SSE 协议定义事件以 `\n` 分隔，行级别解析最自然 |
| buffer 策略 | 保留未完成行 | 处理分块边界截断，避免合并不完整 JSON |
| delta 字段 | 独立 if 检测 | 兼容一个事件多字段并存的情况 |
| chunk 类型 | 胖接口 + 判别式 | 简化 AsyncGenerator 类型签名，代价运行时防御 |
| 参数拼接 | 调用方 Map 累加 | 保持 `chatStream` 无状态，职责分工清晰 |

---

## 相关章节

- [LLM 客户端核心实现](llm-客户端核心实现.md)：`chatStream` 所属的完整客户端，含非流式 `chat` 方法与请求构建
- [工具调用系统](工具调用系统.md)：完整工具执行链路，含 `executeToolCall` 与 10 个内置工具
- [交互式 AI 会话管理](交互式-ai-会话管理.md)：多轮会话中 `toolCallsMap` 与 `messages` 数组的协作
- [两阶段生成流程](两阶段生成流程.md)：`generate.ts` 中工具调用循环的完整上下文