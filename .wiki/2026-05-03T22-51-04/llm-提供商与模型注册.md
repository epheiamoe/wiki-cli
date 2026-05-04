# LLM 提供商与模型注册

你每次执行 `wiki-cli config` 时看到的提供商列表和模型菜单，不是硬编码的静态数据，而是从 `default-models.json` 这个 JSON 文件中动态解析出来的。这篇文档带你走进"注册"的底层——数据从哪里来、如何被解析、怎么判断能力边界、以及如何接入一个不在列表中的自定义服务。

## 注册体系全景

整个注册系统由三个层次构成：

```mermaid
flowchart LR
    A[default-models.json] -->|loadDefaultModels| B[ModelEntry[]]
    B -->|getProviders| C[去重提供商列表]
    B -->|getModelsByProvider| D[按提供商过滤模型]
    E[JSON_MODE_PROVIDERS Set] -->|supportsJsonMode| F[布尔/undefined]
    G[用户输入] -->|Custom 分支| H[手动输入 baseUrl + model]
    H -->|supportsJsonMode 返回 undefined| I[询问是否支持 JSON]
    C --> J[inquirer 列表选择]
    D --> J
    F --> J
```

**第一层** 是数据源 `default-models.json`，为一个 **纯 JSON 数组**，每条记录描述一个"提供商-模型"组合。[来源](src/config/default-models.json)

**第二层** 是 TypeScript 类型定义 `ModelEntry` 和解析函数 `loadDefaultModels`，把 JSON 转为类型安全的对象数组。[来源](src/config/config-store.ts#L14-L20)

**第三层** 是三个核心查询函数——`getProviders`、`getModelsByProvider`、`supportsJsonMode`——它们驱动着交互式配置的每一步。[来源](src/commands/config.ts#L7-L8)

---

## 数据源：default-models.json 的结构

这个文件是项目根下的一个静态 JSON，定义了 **7 个提供商、21 个模型**。每条记录包含 5 个字段：

| 字段 | 含义 | 示例 |
|------|------|------|
| `provider` | 提供商名称，用于分组 | `"OpenAI"`、`"Google Gemini"` |
| `model` | 模型标识符，发送 API 时的 model 参数 | `"gpt-5.4-mini"` |
| `baseUrl` | API 端点地址 | `"https://api.openai.com/v1"` |
| `description` | 人可读的描述，展示给用户 | `"OpenAI GPT-5.4 Mini"` |
| `pricingHint` | 定价提示，辅助用户选择 | `"Balanced performance/cost"` |

每条记录都同时携带 `provider` 和 `baseUrl`——这意味着 **同一提供商下的不同模型可以指向不同的 Base URL**（尽管目前所有内置模型都共用一个地址）。[来源](src/config/default-models.json)

当项目启动时，`loadDefaultModels()` 通过 `import defaultModels from './default-models.json'` 加载这个 JSON，并直接断言为 `ModelEntry[]` 返回。[来源](src/config/config-store.ts#L64-L65)

---

## 类型定义：ModelEntry 与 WikiCliConfig

两个接口区分了"注册数据"和"运行时配置"：

**`ModelEntry`** 描述注册表中的一条记录：
- `provider: string` —— 提供商名称
- `model: string` —— 模型名
- `baseUrl: string` —— API 基地址
- `description: string` —— 模型描述
- `pricingHint?: string` —— 可选的定价提示

**`WikiCliConfig`** 描述用户最终保存的配置：
- `provider: string` —— 选定的提供商
- `baseUrl: string` —— 最终使用的 API 地址
- `model: string` —— 最终选定的模型
- `apiKey: string` —— API 密钥
- `lang: string` —— 文档语言（默认 `'zh'`）
- `jsonMode?: boolean` —— 可选的 JSON 模式开关

两者的关系是：用户从 **ModelEntry 数组**中选择一个组合，其值被提取到 **WikiCliConfig** 中持久化保存到 `~/.wiki-cli/config.json`。[来源](src/config/config-store.ts#L4-L19)

---

## 动态构建提供商列表：getProviders()

```typescript
export function getProviders(models: ModelEntry[]): string[] {
  const providers = new Set(models.map(m => m.provider));
  return [...providers];
}
```

这个函数极其简洁，但体现了整个注册系统的核心设计：**以数据驱动 UI**。

1. `models.map(m => m.provider)` —— 从 21 条记录中提取出 21 个提供商名称（有重复）
2. `new Set(...)` —— 利用 Set 自动去重，得到 7 个唯一名称
3. `[...providers]` —— 展开回数组，供 inquirer 的 `choices` 使用

结果是一个按首次出现在 JSON 中的顺序排列的字符串数组。`config.ts` 调用它时，会在末尾追加一个 `__custom__` 选项供用户选择自定义。[来源](src/config/config-store.ts#L68-L71)[来源](src/commands/config.ts#L38-L44)

---

## 按提供商过滤模型：getModelsByProvider()

```typescript
export function getModelsByProvider(models: ModelEntry[], provider: string): ModelEntry[] {
  return models.filter(m => m.provider === provider);
}
```

用户选中一个提供商后，`config.ts` 用这个函数过滤出该提供商下的所有模型，然后渲染为 inquirer 的 choices 列表。每条选项的显示格式是：

```text
gpt-5.4-mini - OpenAI GPT-5.4 Mini (Balanced performance/cost)
```

即 `${model} - ${description} (${pricingHint})`。这个格式在 `config.ts` 的 `selectedModel` 提示中拼接。[来源](src/config/config-store.ts#L72-L74)[来源](src/commands/config.ts#L56-L60)

---

## JSON 模式支持：supportsJsonMode()

```typescript
const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
]);

export function supportsJsonMode(provider: string): boolean | undefined {
  if (provider === 'Custom') return undefined; // unknown, ask user
  return JSON_MODE_PROVIDERS.has(provider);
}
```

这个函数返回三种可能的值，对应三种处理分支：

| 返回值 | 含义 | 配置行为 |
|--------|------|----------|
| `true` | 已知支持 JSON 模式 | 自动设置 `jsonMode = true`，用户无感知 |
| `false` | 已知不支持 JSON 模式 | 自动设置 `jsonMode = false`，用户无感知 |
| `undefined` | 未知（Custom 提供商） | 弹出 confirm 提示，让用户手动确认 |

目前内置的 7 个提供商中，**5 个支持**（OpenAI、DeepSeek、xAI Grok、Mistral、Kimi）、**2 个不支持**（Google Gemini、Anthropic）。区分依据是是否原生支持 API 参数 `response_format: { type: "json_object" }`。Google Gemini 和 Anthropic 使用各自的 API 协议，不兼容 OpenAI 的 JSON 模式参数。[来源](src/config/config-store.ts#L27-L37)

在 `config.ts` 中，逻辑如下：

```typescript
const known = supportsJsonMode(provider);
if (known === undefined) {
  // 询问用户："Does this provider support JSON output mode?"
} else {
  jsonMode = known;  // 直接使用已知结果
}
```

[来源](src/commands/config.ts#L79-L89)

---

## Custom 提供商：对接任意 API

当你需要的提供商不在内置列表时，选择 `✏️ Custom (enter manually)` 选项。此时配置流程走一个完全不同的分支：

```
选择 Custom
  ├─ 输入 Base URL（手动输入，例如 https://your-proxy.com/v1）
  ├─ 输入 Model 名称（手动输入，例如 llama-3-70b）
  ├─ 输入 API Key
  ├─ 询问 JSON 模式支持（supportsJsonMode('Custom') → undefined）
  └─ 保存配置
```

关键点在于 `provider` 被硬编码为 `'Custom'`。之后在运行时，`supportsJsonMode('Custom')` 会返回 `undefined`，触发交互式确认，因为系统无法预先知道一个自定义端点是否支持 JSON 模式。[来源](src/commands/config.ts#L47-L63)

这个机制让你可以对接：
- 任何兼容 OpenAI API 格式的第三方服务（Ollama、vLLM、LocalAI 等）
- 国内 API 代理或镜像
- 企业内部 LLM 网关

详细的操作步骤见 [配置命令：wiki-cli config](配置命令-wiki-cli-config.md)。

---

## 完整的数据流向

```
default-models.json           (静态注册数据)
       │
       ▼
loadDefaultModels()            (JSON → ModelEntry[])
       │
       ├── getProviders()      (ModelEntry[] → 去重提供商列表)
       │      │
       │      ▼
       │   inquirer 选择提供商
       │      │
       │      ▼
       └── getModelsByProvider() (ModelEntry[] + provider → 过滤后的模型列表)
              │
              ▼
           inquirer 选择模型
              │
              ▼
           提取 baseUrl, model     ← 从选中的 ModelEntry 中提取
              │
              ▼
           输入 apiKey
              │
              ▼
           supportsJsonMode(provider)
              │
              ├── true / false → 自动设置 jsonMode
              └── undefined    → 询问用户
                      │
                      ▼
           saveConfig(WikiCliConfig)  → 持久化到 ~/.wiki-cli/config.json
```

[来源](src/config/config-store.ts#L35-L45)[来源](src/commands/config.ts#L7-L100)

---

## 推荐阅读

- [配置命令：wiki-cli config](配置命令-wiki-cli-config.md) —— 交互式配置的完整用户体验
- [LLM 客户端：流式通信与重试机制](llm-客户端-流式通信与重试机制.md) —— 了解 JSON 模式在 API 请求中如何实际使用
- [添加新的 LLM 提供商](添加新-llm-提供商.md) —— 如果你要扩展内置列表，需要修改哪些文件
- [配置存储与高级选项](配置存储与高级选项.md) —— 配置文件的结构和手动编辑方法