# 自定义 LLM 与 Embedding

wiki-cli 的配置系统围绕一个核心设计原则：**先约定，后扩展**。系统内置了多个主流 LLM Provider 和 Embedding 模型的预配置条目，同时为长尾需求保留了完整的自定义入口。理解这个双层架构，是扩展支持新模型的前提。

## 数据模型

两个接口定义了所有模型条目的形状：

```typescript
// 对话模型
interface ModelEntry {
  provider: string;     // 供应商名称，如 "OpenAI"
  model: string;       // 模型标识，如 "gpt-5.5"
  baseUrl: string;     // API 基础地址
  description: string; // 展示用描述
  pricingHint?: string;// 价格提示
}

// Embedding 模型
interface EmbeddingModelEntry {
  provider: string;
  model: string;
  baseUrl: string;
  description: string;
  dimensions: number;  // 向量维度 —— Embedding 独有字段
  pricingHint?: string;
}
```

区别只在 `EmbeddingModelEntry` 多了一个 `dimensions` 字段。这个字段在[语义搜索与 Embedding](语义搜索与-embedding.md)的检索和缓存逻辑中用于确定向量长度。

[来源](src/config/config-store.ts#L18-L34)

---

## 内置 LLM Provider 注册表

`default-models.json` 是一个顶层 JSON 数组，每个元素对应一个具体模型。当前内置了 21 个模型，分布在 **7 个 Provider** 下：

| Provider | 模型数 | 代表模型 |
|---|---|---|
| OpenAI | 5 | gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5-mini |
| Google Gemini | 3 | gemini-3.1-pro, gemini-3-flash, gemini-3.1-flash-lite |
| Anthropic | 3 | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 |
| xAI Grok | 3 | grok-4.3, grok-4.20-reasoning, grok-4-1-fast-reasoning |
| DeepSeek | 2 | deepseek-v4-pro, deepseek-v4-flash |
| Kimi (Moonshot) | 2 | kimi-k2.6, kimi-k2.5 |
| Mistral | 3 | mistral-large-3, devstral-2, ministral-14b |

`loadDefaultModels()` 简单地将这个 JSON 数组强转为 `ModelEntry[]` 返回。

[来源](src/config/default-models.json#L1-L118)
[来源](src/config/config-store.ts#L93-L95)

---

## 添加新 Provider：三步骤

要在内置列表中增加一个 Provider，只需：

**步骤 1** — 在 `default-models.json` 追加条目。每个条目都需要完整填充所有字段，因为 `getModelsByProvider` 通过 `provider` 字符串做精确匹配。例如添加 Cohere 的对话模型：

```json
{
  "provider": "Cohere",
  "model": "command-r-plus",
  "baseUrl": "https://api.cohere.com",
  "description": "Cohere Command R+",
  "pricingHint": "Optimized for RAG"
}
```

**步骤 2** — 在 `JSON_MODE_PROVIDERS` Set 中添加该 Provider 名称（如果它支持 JSON 输出模式）。这个 Set 驱动 `supportsJsonMode()` 的返回值。

**步骤 3** — 没有步骤 3。`getProviders()` 从模型数组中动态去重提取 Provider 列表，不需要单独注册。

[来源](src/config/config-store.ts#L61-L68)

---

## Custom Provider：手动输入通道

当用户从 Provider 列表中选择 **"✏️ Custom (enter manually)"** 时，系统将 `config.provider` 设置为字面量 `"Custom"`，然后通过 `inquirer` 依次询问 `baseUrl` 和 `model`：

```typescript
if (providerChoice === '__custom__') {
  config.provider = 'Custom';
  const answers = await inquirer.prompt([
    { type: 'input', name: 'baseUrl', message: 'Enter Base URL:', default: config.baseUrl },
    { type: 'input', name: 'model', message: 'Enter model name:', default: config.model },
  ]);
  config.baseUrl = answers.baseUrl;
  config.model = answers.model;
}
```

Custom 模式不填充 `description` 和 `pricingHint`，这些字段对运行时无影响。最终写入 `config.json` 的 `provider` 值固定为 `"Custom"`。

[来源](src/commands/config.ts#L96-L107)

### JSON 模式的分支处理

`supportsJsonMode()` 的逻辑决定了 JSON 模式如何设置：

```typescript
export function supportsJsonMode(provider: string): boolean | undefined {
  if (provider === 'Custom') return undefined;  // 触发交互式确认
  return JSON_MODE_PROVIDERS.has(provider);     // 返回已知结果
}
```

三种返回值对应三种行为：

| 返回值 | 含义 | 交互行为 |
|---|---|---|
| `true` | 已知支持 | 自动将 `jsonMode` 设为 `true`，不询问用户 |
| `false` | 已知不支持 | 自动设为 `false`，不询问用户 |
| `undefined` | 未知（Custom） | 弹出 confirm 提示：*"Does this provider support JSON output mode?"* |

Custom Provider 的 JSON 模式需要用户自行判断，因为系统无法预知用户的私有端点能力。一旦用户确认，结果写入 `config.json` 持久化，后续生成流程直接读取此值，不再重复询问。

[来源](src/config/config-store.ts#L65-L68)
[来源](src/commands/config.ts#L130-L137)

---

## Embedding 模型注册表

与 LLM 不同，Embedding 模型定义在 `config-store.ts` 的静态数组 `EMBEDDING_MODELS` 中，而非外部 JSON 文件。当前内置 9 个模型：

| Provider | 模型 | 维度 |
|---|---|---|
| OpenAI | text-embedding-3-large | 3072 |
| OpenAI | text-embedding-3-small | 1536 |
| OpenAI | text-embedding-ada-002 | 1536 |
| Google Gemini | gemini-embedding-2 | 3072 |
| Cohere | embed-v4 | 4096 |
| Voyage AI | voyage-4-large | 2048 |
| Voyage AI | voyage-4-lite | 2048 |
| Jina AI | jina-embeddings-v3 | 1024 |
| Mistral | mistral-embed | 1024 |

扩展方式与 LLM 一致：在 `EMBEDDING_MODELS` 数组中追加条目。不需要单独注册 Provider 列表 — `getEmbeddingProviders()` 同样从数组中动态提取。

Embedding 没有 JSON 模式的概念，也没有类似 `JSON_MODE_PROVIDERS` 的 Set，配置流程聚焦于 baseUrl、model 和 apiKey 三项。

[来源](src/config/config-store.ts#L36-L54)

### Custom Embedding

用户在 Embedding 配置中选择 Custom 时，交互流程与 LLM 侧对称：

```typescript
if (ep === '__custom__') {
  config.embeddingProvider = 'Custom';
  const answers = await inquirer.prompt([
    { type: 'input', name: 'baseUrl', message: 'Embedding API Base URL:', ... },
    { type: 'input', name: 'model', message: 'Embedding model name:', ... },
  ]);
  config.embeddingBaseUrl = answers.baseUrl;
  config.embeddingModel = answers.model;
}
```

最后询问 API Key 时，允许留空以复用 LLM 的 API Key（通过 `|| config.apiKey` 回退）。这在部署私有嵌入服务时尤其常见，因为私有端点通常不需要独立鉴权。

[来源](src/commands/config.ts#L188-L196)
[来源](src/commands/config.ts#L207-L208)

---

## 运行时消费

自定义配置最终写入 `~/.wiki-cli/config.json`，运行时的消费链路如下：

1. `llm-client.ts` 的 `buildRequest()` 从 `WikiCliConfig` 中读取 `baseUrl`、`model` 和 `apiKey`，拼接出完整的 API 请求 URL 和认证头。
2. `jsonMode` 值决定是否在请求体中注入 `response_format: { type: 'json_object' }`。
3. Embedding 调用链在[语义搜索与 Embedding](语义搜索与-embedding.md) 中实现，同样从配置中读取 `embeddingBaseUrl`、`embeddingModel` 和 `embeddingApiKey`。

[来源](src/ai/llm-client.ts#L56-L76)

---

## 下一步

- 了解配置文件的完整结构：[配置文件详解](配置文件详解.md)
- 查看 LLM 客户端的请求构建细节：[LLM 客户端：流式与非流式](llm-客户端-流式与非流式.md)
- 深入 Embedding 向量的检索与缓存：[语义搜索与 Embedding](语义搜索与-embedding.md)