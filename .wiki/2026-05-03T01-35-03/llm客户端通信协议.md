现在信息充足，开始撰写。

---

# LLM客户端通信协议

本文深入剖析 `src/ai/llm-client.ts` 的设计：它如何将一个面向 OpenAI 兼容 API 的通用客户端抽象为 **流式（SSE）** 与 **非流式** 两种调用模式，以及在网络不稳定的环境下如何通过指数退避重试保证交付。

---

## 一、架构概览

`LLMClient` 是整个 AI 层的通信基础，所有 `[LLM提供商](支持的llm提供商一览.md)` 都通过同一协议交互。其核心职责可分解为三层：

```
┌─────────────────────────────────────┐
│       调用者 (generate.ts)          │
├─────────────────────────────────────┤
│   chatStream() / chat()   ← 双模式  │
├─────────────────────────────────────┤
│   buildRequest()          ← 请求构造 │
├─────────────────────────────────────┤
│   指数退避重试             ← 容错层  │
├─────────────────────────────────────┤
│   fetch()                 ← 传输层  │
└─────────────────────────────────────┘
```

`[来源](src/ai/llm-client.ts#L84-L87)`

---

## 二、ChatMessage 接口 → API 请求体映射

`ChatMessage` 是项目内部的统一消息表示，`serializeMessage()` 将其序列化为标准的 OpenAI Chat Completion 请求体格式：

| ChatMessage 字段 | API 请求体映射 | 行为 |
|---|---|---|
| `role` | `role` | 透传（`system`, `user`, `assistant`, `tool`） |
| `content` | `content` | `null` 时整个字段被删除（规避部分 API 对 null 的报错） |
| `reasoning_content` | `reasoning_content` | 仅非 null 时写入，部分模型（如 DeepSeek-R1）专用 |
| `tool_calls` | `tool_calls` | 数组透传，用于工具调用响应回合 |
| `tool_call_id` | `tool_call_id` | 仅 `role: 'tool'` 时使用，标识被响应的工具调用 |
| `name` | `name` | 可选，一些 API 用于标识函数名 |

关键细节：`content` 在值为 `null` 时执行 `delete msg.content`，而非写入 `null`。这是因为部分 API（如 DeepSeek）严格校验字段类型，不允许 `content: null`。

`[来源](src/ai/llm-client.ts#L29-L41)`

---

## 三、buildRequest：配置 → fetch 请求

`buildRequest()` 将 `WikiCliConfig` 与运行时参数组合为完整的 fetch 配置：

```typescript
function buildRequest(
  config: WikiCliConfig,    // 含 baseUrl, model, apiKey
  messages: ChatMessage[],  // 对话历史
  tools?: ToolDefinition[], // 可选工具定义
  stream?: boolean,         // 是否启用 SSE
  jsonMode?: boolean        // 强制 JSON 输出
): { url: string; headers: Record<string, string>; body: string }
```

**URL 拼接**：`config.baseUrl.replace(/\/+$/, '') + '/chat/completions'` —— 使用正则去除尾部斜杠，保证 URL 格式统一。

**请求体组装**：按以下顺序添加字段：

1. `model` — 来自配置
2. `messages` — 通过 `serializeMessage()` 逐条转换
3. `stream` — 仅 `true` 时写入
4. `tools` — 仅非空数组时写入
5. `response_format` — `jsonMode` 为 `true` 时写入 `{ type: 'json_object' }`

**认证头**：硬编码 `Authorization: Bearer ${config.apiKey}`，统一使用 Bearer Token 方案。

`[来源](src/ai/llm-client.ts#L51-L70)`

---

## 四、chatStream：SSE 流式解析

`chatStream()` 是一个 `AsyncGenerator<StreamChunk>`，逐行消费 SSE（Server-Sent Events）响应，将解析结果以类型化 `StreamChunk` 产出。

### 4.1 SSE 行解析流程

```
原始字节 → TextDecoder.decode({stream: true})
  → 按 '\n' 切分 → 行缓冲（处理跨 chunk 的行碎片）
    → 行.trim() → 跳过空行和非 "data: " 前缀行
      → 去掉 "data: " 前缀（slice(6)）
        → 检测 "[DONE]" 终止信号
          → JSON.parse 解析 payload
```

`[来源](src/ai/llm-client.ts#L117-L127)`

### 4.2 三类 delta 处理

从解析后的 JSON 对象中提取 `choices[0].delta`，根据字段类型分发到三种 `StreamChunk`：

| delta 字段 | 产出 StreamChunk | 消费端行为 |
|---|---|---|
| `delta.content` | `{ type: 'content', content }` | 累加至最终 content，实时打印 |
| `delta.reasoning_content` | `{ type: 'reasoning', reasoning_content }` | 以黄色 dim 样式输出"思考过程" |
| `delta.tool_calls` | `{ type: 'tool_call', tool_call }` | 累积到 toolCallsMap，用于工具执行 |

注意 `tool_calls` 的处理：每个 delta 中的 `tool_calls` 数组需逐一映射为 `ToolCall` 结构（含 `id`, `index`, `type`, `function` 子字段），其中 `tc.function?.arguments` 可能是完整 JSON 字符串的第一个 chunk，由消费端自行拼接。

`[来源](src/ai/llm-client.ts#L129-L150)`

### 4.3 流终止

两种正常终止途径：

- **`data: [DONE]` 信号**：立即 yield `{ type: 'done' }` 并 return
- **读取结束**：while 循环自然结束后 yield `{ type: 'done' }` 并 return

二者结合保证了即使服务端不使用 `[DONE]` 标记（部分提供商变种行为），也能正确结束。

`[来源](src/ai/llm-client.ts#L130-L161)`

---

## 五、chat：非流式响应

`chat()` 是对简单场景的同步风格封装，内部同样使用 fetch，但 `stream: false`：

```typescript
const result = await response.json();
const choice = result.choices?.[0]?.message;
return {
  content: choice?.content || null,
  reasoning_content: choice?.reasoning_content || null,
  tool_calls: choice?.tool_calls || [],
};
```

返回值类型 `LLMResponse` 不同于 `StreamChunk`，它是聚合后的最终结果，不含增量信息。当前项目中 `chat()` 仅用于 [页面生成](页面生成-逐页输出与并行加速.md) 阶段的非流式 Agent 循环（`generate.ts` 第 296 行），在工具调用场景下统一使用非流式以避免 SSE 与工具执行循环的复杂度叠加。

`[来源](src/ai/llm-client.ts#L169-L199)`

---

## 六、指数退避重试

### 6.1 重试判定

`isRetryable(status)` 返回 `true` 的条件：

- **status >= 500**（服务端错误）— 临时性故障，重试可恢复
- **status === 429**（Rate Limit）— 客户端过载，等待后重试

其他客户端错误（4xx 且非 429）直接抛出或 yield error，不重试。

`[来源](src/ai/llm-client.ts#L72-L74)`

### 6.2 退避公式

```
wait = 2^(attempt - 1) * 1000  // attempt = 1, 2, 3
```

| attempt | wait |
|---|---|
| 1（首次重试） | 1000ms |
| 2 | 2000ms |
| 3 | 4000ms |

`MAX_RETRIES = 3`，加上首次尝试共 4 次请求，最大理论等待时间 7 秒。

### 6.3 流式 vs 非流式的重试差异

| 特性 | chatStream | chat |
|---|---|---|
| 重试期间行为 | yield `{ type: 'reasoning', reasoning_content: '[retry 1/3 in 1000ms]' }` | 静默等待 |
| 网络错误 | 捕获后 `continue` | 捕获后 `continue` |
| 流读取中断 | `catch` 后 `continue` 并记录 `lastError` | 不适用 |
| 最终失败 | yield `{ type: 'error' }` | throw Error |

流式模式下，重试期间会产出特殊的 reasoning chunk（如 `[retry 1/3 in 1000ms]`），这种设计使调用方能够在用户界面上显示重试进度。

`[来源](src/ai/llm-client.ts#L90-L110, L178-L191)`

---

## 七、错误处理模式总结

```
┌─ chatStream ─────────────────────────────────┐
│  网络/HTTP错误 → continue → 重试              │
│  达到重试上限 → yield { type: 'error' } → return│
│  [DONE] 或 EOF → yield { type: 'done' } → return│
└──────────────────────────────────────────────┘

┌─ chat ───────────────────────────────────────┐
│  网络/HTTP错误 → continue → 重试              │
│  非重试性 4xx → throw Error（立即）            │
│  达到重试上限 → throw Error                    │
└──────────────────────────────────────────────┘
```

注意 `chatStream` 采用 **生产-消费** 模型：错误通过 `yield { type: 'error' }` 传递，而非抛异常。调用方 `collectFullResponse()` 通过检查 `chunk.type === 'error'` 来感知失败，不会让异常穿透 generator。

---

## 八、与消费端的衔接

`chatStream` 的消费方是 `collectFullResponse()`（位于 `generate.ts:234`），它在一个 `for await` 循环中：

1. 累加 `content` chunk → 最终 content 字符串
2. 累加 `reasoning_content` → 实时打印思考过程
3. 收集 `tool_calls` → 调用工具执行引擎
4. 遇到 `error` → 设置错误标记

而 `chat` 的消费方（`generate.ts:296`）直接 await 结果，通过 `response.tool_calls` 判断是否需要进入工具循环。

详细流程见 [工具调用与Agent循环](工具调用与agent循环.md)。

---

## 推荐阅读

- [项目结构与模块职责](项目结构与模块职责.md) — 了解 `src/ai/` 层在整个架构中的位置
- [工具调用与Agent循环](工具调用与agent循环.md) — 消费端如何驱动多轮工具调用
- [支持的LLM提供商一览](支持的llm提供商一览.md) — 各提供商对 SSE/reasoning_content 的支持差异
- [配置持久化与模型注册表](配置持久化与模型注册表.md) — 了解 `jsonMode` 自动检测的底层逻辑