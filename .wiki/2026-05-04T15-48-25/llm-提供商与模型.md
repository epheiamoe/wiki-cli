页面已存在且内容详尽。为了匹配元数据中的具体要求（初学级别、完整模型表格、JSON 模式标注），我将重写此页面。

---

# LLM 提供商与模型

打开 `wiki-cli config`，你看到的第一个交互页面就是选择 LLM 提供商和模型。这份参考清单列出了所有内置选项、它们各自的推荐模型，以及一个关键配置项——**JSON 模式**——对你的生成结果有什么影响。

## 内置提供商与模型一览

`default-models.json` 注册了 **7 个提供商、21 个模型**。每个提供商及其推荐模型如下表所示，最后一列标注了该提供商是否支持 JSON 输出模式。

| 提供商 | 推荐模型 | 描述 | 价格参考 | JSON 模式 |
|--------|----------|------|----------|:---------:|
| **OpenAI** | `gpt-5.5` | 最新旗舰 | 最贵，质量最高 | ✅ |
| | `gpt-5.4` | 高性价比 | 质量高，成本较低 | ✅ |
| | `gpt-5.4-mini` | 性能/成本平衡 | 推荐日常使用 | ✅ |
| | `gpt-5.4-nano` | 最快最便宜 | OpenAI 最经济选项 | ✅ |
| **Google Gemini** | `gemini-3.1-pro` | 强推理能力 | 价格有竞争力 | ❌ |
| | `gemini-3-flash` | 快速低延迟 | 低成本 | ❌ |
| | `gemini-3.1-flash-lite` | 最便宜 Gemini | 极致省钱 | ❌ |
| **Anthropic** | `claude-opus-4-7` | 复杂分析首选 | 旗舰价格 | ❌ |
| | `claude-sonnet-4-6` | 质量/速度平衡 | 推荐日常 | ❌ |
| | `claude-haiku-4-5` | 快速低成本 | 轻量任务 | ❌ |
| **xAI Grok** | `grok-4.3` | 通用模型 | 价格有竞争力 | ✅ |
| | `grok-4.20-reasoning` | 增强推理 | 推理型场景 | ✅ |
| **DeepSeek** | `deepseek-v4-pro` | 高质量 | 性价比优秀 | ✅ |
| | `deepseek-v4-flash` | 快速经济 | 成本敏感场景 | ✅ |
| **Kimi (Moonshot)** | `kimi-k2.6` | 最新 Kimi 模型 | 最新版 | ✅ |
| | `kimi-k2.5` | 上一代 | 稳定版 | ✅ |
| **Mistral** | `mistral-large-3` | Mistral 最佳 | 旗舰 | ✅ |
| | `devstral-2` | 开发者优先 | 编码场景 | ✅ |
| | `ministral-14b` | 小巧快速 | 轻量部署 | ✅ |

> 每个模型都预配置了对应的 API 基地址（`baseUrl`）。例如所有 OpenAI 模型指向 `https://api.openai.com/v1`，所有 Google Gemini 模型指向 `https://generativelanguage.googleapis.com/v1beta`。

[来源](src/config/default-models.json)

## JSON 模式：它是什么、谁支持

**JSON 模式**（`jsonMode`）是一个开关配置项。开启后，LLM 的输出会被强制约束为有效的 JSON 格式——这对 wiki-cli 自动解析 LLM 返回的结构化内容至关重要。

系统使用一个 **Set** 来记录哪些提供商已知支持 JSON 模式：

```typescript
const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
]);
```

[来源](src/config/config-store.ts#L27-L32)

判断逻辑封装在 `supportsJsonMode` 函数中：

```typescript
export function supportsJsonMode(provider: string): boolean | undefined {
  if (provider === 'Custom') return undefined;
  return JSON_MODE_PROVIDERS.has(provider);
}
```

[来源](src/config/config-store.ts#L33-L36)

这个函数返回三种结果，对应三种不同的用户体验：

| 返回值 | 含义 | 配置时的行为 |
|--------|------|-------------|
| `true` | 已知支持 | 自动设置 `jsonMode = true`，用户无感知 |
| `false` | 已知不支持 | 自动设置 `jsonMode = false`，用户无感知 |
| `undefined` | 未知（Custom） | 弹窗询问"Does this provider support JSON output mode?" |

从表格可以看到：**OpenAI、DeepSeek、xAI Grok、Mistral、Kimi** 这 5 个提供商原生支持 OpenAI 兼容的 `response_format: { type: "json_object" }` 参数；**Google Gemini 和 Anthropic** 使用各自的 API 协议，不兼容该参数，因此 JSON 模式默认关闭。

[来源](src/commands/config.ts#L79-L89)

## Custom 提供商：手动接入任意 API

当所需的服务不在内置的 7 个提供商中时，在配置中选择 **✏️ Custom (enter manually)**。此时流程变为手动输入模式：

```
选择 Custom
  → 输入 Base URL（如 https://your-ollama-server:11434/v1）
  → 输入 Model 名称（如 llama-3-70b）
  → 输入 API Key（即便不需要也要填占位符）
  → 系统询问是否支持 JSON 模式（因为 supporstJsonMode('Custom') → undefined）
  → 保存配置
```

[来源](src/commands/config.ts#L47-L63)

Custom 模式的核心要点：
- `provider` 被硬编码为字符串 `'Custom'`
- `baseUrl` 和 `model` 完全由你手动输入，没有任何下拉选择
- `supportsJsonMode('Custom')` 返回 `undefined`，所以系统会弹出 confirm 让你自行判断

这让你可以对接任何**兼容 OpenAI API 格式**的服务，包括：
- 本地部署的 **Ollama**、**vLLM**、**LocalAI**
- 国内 API 代理或镜像服务
- 企业内部的 LLM 网关

## jsonMode 的实际影响

`jsonMode` 配置项最终会写入 `~/.wiki-cli/config.json` 文件。在生成 Wiki 时，LLM 客户端会读取这个值来决定是否在 API 请求中附加 JSON 模式参数。对于支持它的提供商，开启后 LLM 返回的内容一定是合法 JSON，减少了解析错误；对于不支持的提供商，开启此选项不会生效，但也不会报错——系统会忽略它。

[来源](src/config/config-store.ts#L4-L13)

详细了解 JSON 模式在 API 请求中如何工作的，见 [LLM 客户端：流式通信与重试机制](llm-客户端-流式通信与重试机制.md)。

## 推荐阅读

- [配置命令：wiki-cli config](配置命令-wiki-cli-config.md) —— 完整的交互式配置流程
- [LLM 客户端：流式通信与重试机制](llm-客户端-流式通信与重试机制.md) —— JSON 模式在 API 层的实际使用
- [Embedding 语义搜索配置](embedding-语义搜索配置.md) —— 配置 embedding 模型实现语义搜索
- [配置存储架构](配置存储架构.md) —— `config.json` 文件结构与手动编辑方法