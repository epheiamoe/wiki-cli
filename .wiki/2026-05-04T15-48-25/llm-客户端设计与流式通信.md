这个页面已存在于 Wiki 中（slug: `llm-客户端-流式通信与重试机制`），内容已覆盖您要求的所有 5 个要点。以下是根据 `src/ai/llm-client.ts` 重新编写的版本，聚焦于**双通道接口设计意图**这一核心矛盾，以不同于已有页面的视角组织材料。

---

# LLM 客户端设计与流式通信

`LLMClient` 是项目中与 LLM API 通信的唯一抽象层，位于 `src/ai/llm-client.ts`。它只有约 150 行，却承担了 **双通道接口、SSE 流式解析、指数退避重试、消息序列化** 四重职责。理解它的设计，就理解了整个 AI 层如何与外部模型交互。

## 核心类型系统

客户端定义了四个接口，构成完整的对话类型体系：

| 接口 | 用途 | 关键字段 |
|---|---|---|
| `ChatMessage` | 对话历史中的单条消息 | `role`, `content?`, `reasoning_content?`, `tool_calls?`, `tool_call_id?` |
| `ToolCall` | 函数调用请求的结构 | `id`, `index?`, `type: 'function'`, `function: { name, arguments }` |
| `StreamChunk` | 流式输出的最小事件单元 | `type: 'content'\|'reasoning'\|'tool_call'\|'done'\|'error'` |
| `LLMResponse` | 非流式完整响应 | `content`, `reasoning_content?`, `tool_calls[]` |

`ChatMessage.content` 声明为 `string | null | undefined`——三重态并非冗余，而是为 `serializeMessage` 的精确控制留出空间：`undefined` 表示未设置，`null` 表示模型显式返回空（如 tool_call 时 OpenAI 规范要求 content 为 null），两者在序列化时行为不同。 [来源](src/ai/llm-client.ts#L1-L30)

## 双通道接口设计：AsyncGenerator vs Promise

`LLMClient` 最核心的设计决策是暴露两个独立的接口方法：

```typescript
async *chatStream(messages, tools?, jsonMode?): AsyncGenerator<StreamChunk>
async chat(messages, tools?, jsonMode?): Promise<LLMResponse>
```

### 设计意图

两个方法解决的问题不同：

- **`chatStream`**：面向**实时交互**场景。调用方需要在 token 生成过程中逐步获取内容，例如 [AI 交互命令：wiki-cli ai](ai-交互命令-wiki-cli-ai.md) 中的打字机效果，或者 [生成管线：从大纲到页面的完整流程](生成管线-从大纲到页面的完整流程.md) 中工具调用的增量聚合。
- **`chat`**：面向**批量处理**场景。调用方只需要最终结果，例如生成最终页面内容，无需中间状态也不关心推理过程。

### 差异矩阵

| 维度 | `chatStream` | `chat` |
|---|---|---|
| 返回类型 | `AsyncGenerator<StreamChunk>` | `Promise<LLMResponse>` |
| 请求体 `stream` | `true` | `false`（或不传） |
| 响应解析 | 逐行 SSE 增量解析 | `response.json()` 一次解析 |
| 错误通知 | `yield { type: 'error', error }` | `throw Error` |
| 重试可见性 | yield reasoning 消息通知用户 | 静默重试 |
| 适用场景 | 交互式对话、工具调用循环 | 页面生成、批处理 |

两个方法**共享同一套重试骨架**（见后文），仅在三处分支：请求体 `stream` 字段、错误传播方式、响应提取逻辑。 [来源](src/ai/llm-client.ts#L91-L225)

## SSE 流式解析：三行模式的容错引擎

`chatStream` 中的 SSE 解析是最密集的算法区域，核心是一个三层嵌套循环：

```
外层：for (attempt)         → 重试循环
 中层：while (true)         → 流读取循环
  内层：for (lines)         → 行处理循环
```

### TCP 分片容错

```typescript
const { done, value } = await reader.read();
buffer += decoder.decode(value, { stream: true });  // (1)
const lines = buffer.split('\n');                    // (2)
buffer = lines.pop() || '';                          // (3)
```

这是流式解析的经典三行模式：

1. **`TextDecoder` 的 `stream: true` 标志**：告诉解码器保留不完整的多字节 UTF-8 序列在内部状态中，等待下一块数据补齐。如果没有这个标志，一个中文字符被 TCP 分片切成两半时，前半部分会变成乱码 `�`。
2. **按 `\n` 切分**：将累积的 buffer 切分为候选行。
3. **`lines.pop()` 回留**：最后一段可能是不完整的行，留在 buffer 中等待下一次 `reader.read()`。

这种处理保证了即使 SSE 数据在任意 UTF-8 字符边界被网络分片切断，也不会出现乱码或丢行。 [来源](src/ai/llm-client.ts#L128-L141)

### data: 行协议

对每个有效行，去掉 `data: ` 前缀后分叉：

```
data: [DONE]                              → yield { type: 'done' }; return
data: {"choices":[{"delta":{...}}}]       → JSON.parse → 提取 delta
```

从 `delta` 中按存在字段分发三种事件：

```typescript
if (delta?.content)             → { type: 'content', content }
if (delta?.reasoning_content)   → { type: 'reasoning', reasoning_content }
if (delta?.tool_calls)          → { type: 'tool_call', tool_call }
```

**`content` 使用真值检查而非 `!== undefined`**：空字符串 `""` 不会 yield。这与 OpenAI SSE 规范一致——空 content 表示此 delta 没有文本变更，yield 出去只会增加调用方的无意义处理。 [来源](src/ai/llm-client.ts#L149-L175)

### tool_calls 的增量聚合

`tool_calls` 是数组，每个元素携带 `index` 属性。消费方（如 `generate.ts`）利用 `index` 做增量聚合：

```typescript
const key = tc.index !== undefined ? `_idx_${tc.index}` : tc.id;
if (toolCallsMap.has(key)) {
  const existing = toolCallsMap.get(key)!;
  existing.function.arguments += tc.function.arguments;  // 追加参数片段
}
```

这意味着同一个工具调用的 `arguments` 可能分布在多个 SSE 事件中，消费方按 `index` 归并。 [来源](src/commands/generate.ts#L365-L374)

## 指数退避重试：3 次 + 可重试性判断

### 重试骨架

两个方法共享同一个 `for (let attempt = 0; attempt <= MAX_RETRIES; attempt++)` 循环。`MAX_RETRIES = 3` 意味着最多 4 次尝试（第 0 次 + 3 次重试）。

### 可重试性函数

```typescript
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}
```

| 状态码 | 含义 | 重试？ |
|---|---|---|
| 429 | Rate Limit | ✅ 是 |
| 5xx | 服务端错误 | ✅ 是 |
| 4xx（非429） | 客户端错误 | ❌ **否** |

**设计原则：Fail Fast for Client Errors**。401 认证失败、404 端点不存在、400 请求格式错误——重试只会浪费时间和配额，直接终止。 [来源](src/ai/llm-client.ts#L86-L88)

### 退避时间序列

```typescript
const wait = Math.pow(2, attempt - 1) * 1000;
```

| attempt | 等待时间 | 累计 |
|---|---|---|
| 0 | 0ms（首次） | 0ms |
| 1 | 1,000ms | 1s |
| 2 | 2,000ms | 3s |
| 3 | 4,000ms | 7s |

总最长等待 7 秒。指数退避的 rationale：短暂的服务抖动（毫秒级）在第一次重试后就恢复；区域性故障（秒级）需要更长等待；`Math.pow(2, n-1)*1000` 是业界标准做法。 [来源](src/ai/llm-client.ts#L103-L108)

### 流式重试的可见性

`chatStream` 在重试前 yield 一条特殊的 reasoning 消息：

```typescript
yield { type: 'reasoning', reasoning_content: `\n[retry ${attempt}/${MAX_RETRIES} in ${wait}ms]` };
```

这使得消费方（如 `ai.ts` 的终端界面）能将重试状态展示给用户，而非静默卡死。`chat` 则静默重试，因为批量场景下用户不关心中间状态。 [来源](src/ai/llm-client.ts#L107-L109)

## `serializeMessage`：消息净化的精细控制

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
  if (msg.content === null) delete msg.content;  // 关键行
  return msg;
}
```

**最后一行是设计精髓**。当模型返回 `tool_calls` 时，OpenAI 规范中 `content` 常常为 `null`。但某些提供商（如 DeepSeek）的 API 在收到 `"content": null` 时返回校验错误——它们要求要么 `content` 是有效字符串，要么完全不传。这行代码确保 `null` 被从对象中完全移除。

为什么用 `delete` 而不是短路赋值？因为前面第 2 行已经无条件设置了 `msg.content = m.content`（当 `content !== undefined`），其中可能包含 `null`。`delete` 是在赋值后的修正。

`reasoning_content` 的处理同样精细：仅在非 `undefined` **且**非 `null` 时才写入，防止对话历史中出现 `"reasoning_content": null` 的冗余字段。 [来源](src/ai/llm-client.ts#L38-L49)

## 无状态设计

```typescript
export class LLMClient {
  private config: WikiCliConfig;
  constructor(config: WikiCliConfig) { this.config = config; }
}
```

`LLMClient` 仅持有一个配置引用，不持有任何可变状态。这带来三个工程收益：

1. **实例可复用**：同一实例可安全地在多次对话调用间共享，无需每次 new。
2. **天然可测试**：测试时只需 `vi.fn()` mock `globalThis.fetch`，无需依赖注入容器。参见 [测试策略与 Vitest 配置](测试策略与-vitest-配置.md)。
3. **无副作用构造**：构造函数仅赋值，无异步操作或资源分配。 [来源](src/ai/llm-client.ts#L98-L102)

## 集成关系

```mermaid
flowchart LR
    subgraph 命令层
        GEN[generate.ts]
        AI[ai.ts]
    end
    subgraph AI核心
        LC[LLMClient]
        T[tools.ts]
    end
    subgraph 配置层
        CS[config-store.ts]
    end
    subgraph 模板层
        P[prompts.ts]
    end

    CS -->|WikiCliConfig| LC
    GEN -->|chatStream / chat| LC
    AI -->|chatStream| LC
    LC -->|fetch| API[LLM Provider]
    T -->|ToolDefinition[]| LC
    P -->|ChatMessage[]| GEN
```

- [AI 交互命令：wiki-cli ai](ai-交互命令-wiki-cli-ai.md) 仅使用 `chatStream` 实现流式打字机效果
- [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) 的工具循环使用 `chatStream`，页面生成使用 `chat`
- [工具系统：LLM 只读探索工具的设计](工具系统-llm-只读探索工具的设计.md) 提供 `ToolDefinition[]` 的具体实现

## 推荐阅读

- [生成管线：从大纲到页面的完整流程](生成管线-从大纲到页面的完整流程.md) — 看 `chatStream` 在工具调用循环中如何被消费
- [LLM 提供商与模型注册](llm-提供商与模型注册.md) — 理解 `jsonMode` 兼容性如何影响 `buildRequest`
- [测试策略与 Vitest 配置](测试策略与-vitest-配置.md) — 查看 `llm-client.test.ts` 中 mock SSE 流和重试验证的实现