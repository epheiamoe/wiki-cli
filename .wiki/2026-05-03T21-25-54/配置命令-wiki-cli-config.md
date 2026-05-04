现在开始编写页面。

# 配置命令：wiki-cli config

`wiki-cli config` 是你使用 wiki-cli **必须最先执行** 的一条命令。它的唯一职责：告诉工具「用哪个 AI 模型、拿谁的 API Key、写哪种语言」。

这条命令有两种工作模式——**交互式向导**（新手推荐）和 **命令行参数批量配置**（脚本化场景）。无论哪种模式，最终结果都是一份保存在 `~/.wiki-cli/config.json` 的配置文件。

---

## 交互式配置：逐个步骤的向导

不带任何参数直接运行 `wiki-cli config`，你会看到一台交互式问答机。下面演示完整的 5 步流程。

### 第 1 步：选择 LLM 提供商

```text
? Select LLM provider: (Use arrow keys)
❯ OpenAI
  Google Gemini
  Anthropic
  xAI Grok
  DeepSeek
  Kimi (Moonshot)
  Mistral
  ✏️  Custom (enter manually)
```

从 7 个内置提供商中选择一个。如果这里没有你想要的（比如你想接入本地的 Ollama 或兼容 OpenAI API 的其他服务），选最底部的 **Custom**，后续手动输入 Base URL 和模型名。[来源](src/commands/config.ts#L24-L34)

### 第 2 步：选择模型

选了内置提供商后，进入该提供商的模型列表。以 DeepSeek 为例：

```text
? Select model for DeepSeek:
❯ deepseek-v4-pro - DeepSeek V4 Pro (High quality, competitive price)
  deepseek-v4-flash - DeepSeek V4 Flash (Fast, cost-effective)
```

每个模型附带价格提示（如 `Most expensive, highest quality`），帮助你在质量和成本之间做权衡。如果选的是 Custom，这一步会变成两个自由输入框：`Enter Base URL` 和 `Enter model name`。[来源](src/commands/config.ts#L43-L56)

### 第 3 步：输入 API Key

```text
? Enter API Key: [***********************]
```

采用密码输入模式，你输入的每个字符都会被 `*` 遮蔽，防止旁人窥屏。如果之前保存过配置，这里会以默认值形式填充旧 Key（同样遮蔽显示）。[来源](src/commands/config.ts#L59-L65)

### 第 4 步：确认 JSON Mode（自动跳过已知提供商）

这一步在不同场景下表现不同：

- 已知支持 JSON 模式的提供商（OpenAI、DeepSeek、xAI Grok、Mistral、Kimi）→ **自动跳过**，静默启用
- 已知不支持 JSON 模式的提供商（Google Gemini、Anthropic）→ **自动跳过**，静默禁用
- Custom 模式 → **弹出确认**，询问 "Does this provider support JSON output mode?"

```text
? Does this provider support JSON output mode (response_format: json_object)? (Y/n)
```

JSON Mode 控制生成大纲时 LLM 是否以严格的 JSON 对象格式返回，这对后续的结构解析至关重要。[来源](src/config/config-store.ts#L22-L39)

### 第 5 步：选择文档语言

```text
? Documentation language (zh/en, default zh): zh
```

输入 `zh` 指中文，`en` 指英文。默认值为 `zh`。[来源](src/commands/config.ts#L93-L99)

### 完成

五个步骤全部回答完毕后，终端打印成功消息：

```text
✔ Configuration saved to C:\Users\<你的用户名>\.wiki-cli\config.json
```

至此，配置完成，可以立刻执行 `wiki-cli generate` 开始生成文档了。完整的端到端流程见 [快速开始](快速开始.md)。[来源](src/commands/config.ts#L101-L105)

---

## 命令行参数批量配置：一行搞定

如果你不喜欢交互问答，或者想把配置步骤写进自动化脚本，**同时提供**下面四个参数即可跳过向导、直接保存：

```bash
wiki-cli config \
  --provider DeepSeek \
  --model deepseek-v4-flash \
  --base-url https://api.deepseek.com \
  --api-key sk-your-key-here \
  --lang zh
```

| 参数 | 说明 | 必需 |
|------|------|------|
| `--provider` | 提供商名称，需与内置列表一致（如 `OpenAI`） | ✅ 是 |
| `--base-url` | API 端点地址（如 `https://api.deepseek.com`） | ✅ 是 |
| `--model` | 模型标识（如 `deepseek-v4-flash`） | ✅ 是 |
| `--api-key` | API 密钥 | ✅ 是 |
| `--lang` | 文档语言，`zh` 或 `en`，默认 `zh` | ❌ 否 |

[来源](src/commands/config.ts#L11-L19)

---

## CLI 参数优先逻辑：什么时候交互？

代码中有一条简洁的判断规则：

```typescript
if (options.apiKey && options.baseUrl && options.model && options.provider) {
  // 四个关键参数齐全 → 直接保存，跳过交互
  const config = { provider, baseUrl, model, apiKey, lang };
  await saveConfig(config);
  return;
}
// 缺少任何一个 → 进入交互式向导
```

也就是说，只要 **同时存在** `--api-key`、`--base-url`、`--model`、`--provider` 这四个参数，命令就认为你已经有完整的配置知识了，不再啰嗦。`--lang` 是可选的，未传入时默认 `zh`。

如果只传了部分参数（比如只传了 `--provider` 没传 `--api-key`），**仍然会进入交互模式**，已传入的参数值会作为对应问题的默认值预填好。

[来源](src/commands/config.ts#L11-L19)

---

## 配置持久化：`~/.wiki-cli/config.json`

所有配置信息最终写入用户主目录下的一个 JSON 文件：

| 系统 | 完整路径 |
|------|---------|
| Windows | `C:\Users\<用户名>\.wiki-cli\config.json` |
| macOS | `/Users/<用户名>/.wiki-cli/config.json` |
| Linux | `/home/<用户名>/.wiki-cli/config.json` |

文件内容的结构如下：

```json
{
  "provider": "DeepSeek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "apiKey": "sk-your-key-here",
  "lang": "zh",
  "jsonMode": true
}
```

每个字段的对应关系：

| 字段 | 类型 | 说明 | 对应参数 |
|------|------|------|---------|
| `provider` | string | 提供商名称 | `--provider` |
| `baseUrl` | string | API 端点 | `--base-url` |
| `model` | string | 模型标识 | `--model` |
| `apiKey` | string | 你的 API 密钥 | `--api-key` |
| `lang` | string | `"zh"` 或 `"en"` | `--lang` |
| `jsonMode` | boolean | 是否启用 JSON 输出模式 | 由系统自动判定或询问 |

你可以手动编辑这个文件来修改配置，但更推荐的做法是重新运行 `wiki-cli config`——它可以利用交互式向导的列表选择功能，防止你输错模型名称。

配置目录（`~/.wiki-cli/`）和配置文件由 `saveConfig()` 函数在首次保存时自动创建，无需手动 `mkdir`。[来源](src/config/config-store.ts#L9-L12)

关于配置文件的深度讲解（如 jsonMode 的底层作用、模型注册表机制），见 [配置存储与模型清单](配置存储与模型清单.md)。

---

## 内置提供商与完整模型列表

wiki-cli 内置了 **7 个提供商、21 个模型**。下表供查询：

| 提供商 | 模型名 | 描述 | 价格提示 |
|--------|--------|------|---------|
| **OpenAI** | `gpt-5.5` | 最新旗舰 | 最贵，质量最高 |
| | `gpt-5.4` | GPT-5.4 | 高质量，成本低于 5.5 |
| | `gpt-5.4-mini` | GPT-5.4 Mini | 性能与成本的平衡 |
| | `gpt-5.4-nano` | GPT-5.4 Nano | 最快最便宜的 OpenAI |
| | `gpt-5-mini` | GPT-5 Mini | 上一代 mini |
| **Google Gemini** | `gemini-3.1-pro` | Gemini 3.1 Pro | 定价有竞争力，推理强 |
| | `gemini-3-flash` | Gemini 3 Flash | 快速，低成本 |
| | `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 最便宜的 Gemini |
| **Anthropic** | `claude-opus-4-7` | Claude Opus 4.7 | 最适合复杂分析 |
| | `claude-sonnet-4-6` | Claude Sonnet 4.6 | 质量与速度的平衡 |
| | `claude-haiku-4-5` | Claude Haiku 4.5 | 快速，低成本 |
| **xAI Grok** | `grok-4.3` | Grok 4.3 | 有竞争力的定价 |
| | `grok-4.20-reasoning` | Grok 4.20 Reasoning | 增强推理 |
| | `grok-4-1-fast-reasoning` | Grok 4.1 Fast Reasoning | 快速推理变体 |
| **DeepSeek** | `deepseek-v4-pro` | DeepSeek V4 Pro | 高质量，竞争价格 |
| | `deepseek-v4-flash` | DeepSeek V4 Flash | 快速，有性价比 |
| **Kimi (Moonshot)** | `kimi-k2.6` | Kimi K2.6 | 最新 Kimi 模型 |
| | `kimi-k2.5` | Kimi K2.5 | 上一代 Kimi |
| **Mistral** | `mistral-large-3` | Mistral Large 3 | Mistral 最佳模型 |
| | `devstral-2` | Devstral 2 | 面向开发者 |
| | `ministral-14b` | Ministral 14B | 小巧快速便宜 |

[来源](src/config/default-models.json#L1-L65)

如果你需要的模型不在上表中，可以：
1. 选择 **Custom** 模式手动输入任意 Base URL 和模型名
2. 阅读 [添加新 LLM 提供商](添加新-llm-提供商.md) 了解如何扩展内置列表

> 完整的模型对比和选择建议，参见 [LLM 提供商与模型选择](llm-提供商与模型选择.md)。

---

## 下一步

配置完成后，你可以：

- [快速开始](快速开始.md) — 从零到一跑完整条流程
- [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) — 进入生成阶段
- [配置存储与模型清单](配置存储与模型清单.md) — 深入理解配置文件的底层机制