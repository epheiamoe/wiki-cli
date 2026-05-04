以下是您需要的页面内容——我已经阅读了 `default-models.json` 和 `config-store.ts`，确认了全部 21 个模型条目、JSON mode 支持清单以及 Custom 模式的工作原理。

---

# 支持的LLM提供商一览

wiki-cli 内置了 7 家 LLM 提供商的 **21 个模型**，覆盖从顶级旗舰到轻量经济的各类选择。此外，你还可以通过 **Custom 模式** 接入任意兼容 OpenAI 格式的 API。

---

## 7 大提供商 · 21 个模型

下表按提供商分组，列出了所有内置模型及其 API 地址、能力定位和价格提示，方便你根据任务和预算做出选择。

| 提供商 | 模型名 | API 基础地址 | 描述 | 定价提示 |
|---------|--------|-------------|------|---------|
| **OpenAI** | `gpt-5.5` | https://api.openai.com/v1 | OpenAI GPT-5.5（最新旗舰） | 最贵，质量最高 |
| | `gpt-5.4` | https://api.openai.com/v1 | OpenAI GPT-5.4 | 高质量，比 5.5 便宜 |
| | `gpt-5.4-mini` | https://api.openai.com/v1 | OpenAI GPT-5.4 Mini | 性能/成本均衡 |
| | `gpt-5.4-nano` | https://api.openai.com/v1 | OpenAI GPT-5.4 Nano | OpenAI 最快最便宜的模型 |
| | `gpt-5-mini` | https://api.openai.com/v1 | OpenAI GPT-5 Mini | 旧款 Mini 模型 |
| **Google Gemini** | `gemini-3.1-pro` | https://generativelanguage.googleapis.com/v1beta | Google Gemini 3.1 Pro | 定价有竞争力，推理强 |
| | `gemini-3-flash` | https://generativelanguage.googleapis.com/v1beta | Google Gemini 3 Flash | 快速，低成本 |
| | `gemini-3.1-flash-lite` | https://generativelanguage.googleapis.com/v1beta | Google Gemini 3.1 Flash Lite | 最便宜的 Gemini 模型 |
| **Anthropic** | `claude-opus-4-7` | https://api.anthropic.com/v1 | Claude Opus 4.7 | 最适合复杂分析 |
| | `claude-sonnet-4-6` | https://api.anthropic.com/v1 | Claude Sonnet 4.6 | 质量/速度均衡 |
| | `claude-haiku-4-5` | https://api.anthropic.com/v1 | Claude Haiku 4.5 | 快速，低成本 |
| **xAI Grok** | `grok-4.3` | https://api.x.ai/v1 | Grok 4.3 | 有竞争力的定价 |
| | `grok-4.20-reasoning` | https://api.x.ai/v1 | Grok 4.20 Reasoning | 增强推理 |
| | `grok-4-1-fast-reasoning` | https://api.x.ai/v1 | Grok 4.1 Fast Reasoning | 快速推理变体 |
| **DeepSeek** | `deepseek-v4-pro` | https://api.deepseek.com | DeepSeek V4 Pro | 高质量，有竞争力的价格 |
| | `deepseek-v4-flash` | https://api.deepseek.com | DeepSeek V4 Flash | 快速，高性价比 |
| **Kimi (Moonshot)** | `kimi-k2.6` | https://api.moonshot.cn/v1 | Moonshot Kimi K2.6 | 最新 Kimi 模型 |
| | `kimi-k2.5` | https://api.moonshot.cn/v1 | Moonshot Kimi K2.5 | 前代 Kimi 模型 |
| **Mistral** | `mistral-large-3` | https://api.mistral.ai/v1 | Mistral Large 3 | Mistral 最强模型 |
| | `devstral-2` | https://api.mistral.ai/v1 | Devstral 2 | 面向开发者的模型 |
| | `ministral-14b` | https://api.mistral.ai/v1 | Ministral 14B | 小体积，快速，便宜 |

[来源](src/config/default-models.json#L1-L65)

---

## Custom 模式：接入任意兼容 API

如果内置列表中没有你想要的提供商或模型，交互式配置向导（`wiki-cli config`）提供了 **Custom 模式**。选择 `✏️ Custom (enter manually)` 后，你可以手动输入：

- **baseUrl** —— 任意 API 地址
- **model** —— 任意模型名
- **apiKey** —— 对应的密钥

系统会存储为 `provider: "Custom"`，并允许你自由输入上述字段。[来源](src/commands/config.ts#L32-L49)

这意味着：只要你使用的 API 兼容 OpenAI 的聊天补全格式（绝大多数现代 LLM API 都支持），就可以通过 Custom 模式接入使用。

---

## JSON Mode 支持情况

wiki-cli 在生成结构化内容（如维基大纲）时会利用 **JSON mode**，让模型以 JSON 格式返回结果，从而提升解析可靠性。

以下提供商 **内置支持 JSON mode**（自动启用，无需手动配置）：

| 支持 JSON Mode |
|---------------|
| OpenAI |
| DeepSeek |
| xAI Grok |
| Mistral |
| Kimi (Moonshot) |

以下提供商 **暂不支持 JSON mode**：

| 不支持 JSON Mode |
|-----------------|
| Anthropic |
| Google Gemini |

对于 Custom 模式（`provider === 'Custom'`），系统无法预先判断，因此配置时会被询问是否启用 JSON mode，由你自行决定。[来源](src/config/config-store.ts#L27-L39)

---

## 如何选择模型？

- **追求极致质量** → OpenAI `gpt-5.5` 或 Anthropic `claude-opus-4-7`
- **性价比均衡** → OpenAI `gpt-5.4-mini`、DeepSeek `deepseek-v4-pro`、xAI `grok-4.3`
- **快速廉价批量任务** → OpenAI `gpt-5.4-nano`、Mistral `ministral-14b`、Google `gemini-3.1-flash-lite`
- **中文场景友好** → Kimi (Moonshot) 系列、DeepSeek 系列
- **自定义接入** → 使用 [Custom 模式](#custom-模式接入任意兼容-api)

更详细的配置指引请参阅 [安装与配置详解](安装与配置详解.md)。

---

> **下一篇推荐**：[配置持久化与模型注册表](配置持久化与模型注册表.md) —— 深入了解配置如何存储、模型注册表的结构以及 JSON mode 的自动检测机制。