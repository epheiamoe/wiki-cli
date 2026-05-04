现在开始编写页面。

# 配置你的 LLM 提供商

在生成 Wiki 文档之前，你需要告诉 wiki-cli **用哪个 AI 模型来分析和写作**。配置工作只需一次，之后的所有操作都会自动使用这套配置。

## 第一步：选择提供商和模型

wiki-cli 内置了 **7 个 LLM 提供商**，每个提供商下有若干预置模型。下表列出每个提供商的代表性模型及其特点：

| 提供商 | 代表性模型 | API 基础地址 | 特点 |
|--------|-----------|-------------|------|
| **OpenAI** | `gpt-5.5` | `https://api.openai.com/v1` | 旗舰模型，质量最高 |
| **Google Gemini** | `gemini-3.1-pro` | `https://generativelanguage.googleapis.com/v1beta` | 推理能力强，定价有竞争力 |
| **Anthropic** | `claude-opus-4-7` | `https://api.anthropic.com/v1` | 最适合复杂分析 |
| **xAI Grok** | `grok-4.3` | `https://api.x.ai/v1` | 有竞争力的定价 |
| **DeepSeek** | `deepseek-v4-pro` | `https://api.deepseek.com` | 中文友好，性价比高 |
| **Kimi (Moonshot)** | `kimi-k2.6` | `https://api.moonshot.cn/v1` | 中文场景优化 |
| **Mistral** | `mistral-large-3` | `https://api.mistral.ai/v1` | 欧洲最强模型 |

每个提供商下还有多个细分模型（如 OpenAI 的 Mini/Nano 系列、Gemini 的 Flash 系列），完整的 21 个模型清单见 [支持的LLM提供商一览](支持的llm提供商一览.md)。[来源](src/config/default-models.json#L1-L65)

如果预置列表中没有你想要的，你还可以选择 **Custom 模式**，手动输入任意 Base URL 和模型名，接入任何兼容 OpenAI API 格式的服务。[来源](src/commands/config.ts#L32-L49)

---

## 两种配置方式

### 方式一：交互式配置（推荐新手）

在终端中运行：

```bash
wiki-cli config
```

程序会依次引导你完成 5 个步骤：

1. **选择提供商** — 从 7 个内置提供商或 Custom 中选择
2. **选择模型** — 在该提供商下选择一个具体模型（含价格提示）
3. **输入 API Key** — 以密码模式输入（显示为 `*`）
4. **确认 JSON Mode** — 已知支持的提供商自动跳过此步
5. **选择文档语言** — 输入 `zh`（中文）或 `en`（英文）

全部完成后，终端会显示配置保存路径。[来源](src/commands/config.ts#L9-L104)

更详细的步骤说明请见 [安装与配置详解](安装与配置详解.md)。

### 方式二：命令行参数快捷配置（适合脚本化）

如果你不想经历交互问答，可以一次性传入所有必要参数。当 **同时提供** `--provider`、`--base-url`、`--model`、`--api-key` 四个参数时，配置会直接保存，跳过交互：

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
| `--provider` | 提供商名称 | 是 |
| `--base-url` | API 基础地址 | 是 |
| `--model` | 模型名称 | 是 |
| `--api-key` | API 密钥 | 是 |
| `--lang` | 文档语言（zh/en） | 否，默认 zh |

判断逻辑见代码：四个参数同时存在时直接保存，缺少任何一个则回退到交互向导。[来源](src/commands/config.ts#L11-L19)

---

## 配置文件在哪里？

配置持久化在用户主目录下：

```
~/.wiki-cli/config.json
```

各系统的实际路径：

| 系统 | 路径 |
|------|------|
| Windows | `C:\Users\<你的用户名>\.wiki-cli\config.json` |
| macOS | `/Users/<你的用户名>/.wiki-cli/config.json` |
| Linux | `/home/<你的用户名>/.wiki-cli/config.json` |

文件内容是一个 JSON 对象，包含 6 个字段：

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 提供商名称，如 `"OpenAI"` |
| `baseUrl` | string | API 端点地址 |
| `model` | string | 模型标识，如 `"gpt-5.5"` |
| `apiKey` | string | 你的 API 密钥 |
| `lang` | string | 文档语言：`"zh"` 或 `"en"` |
| `jsonMode` | boolean (可选) | 是否启用 JSON 输出模式 |

你可以直接编辑这个文件来修改配置，但更稳妥的方式是重新运行 `wiki-cli config`。[来源](src/config/config-store.ts#L6-L12)

---

## 理解 jsonMode 选项

**jsonMode** 控制 wiki-cli 是否在 API 请求中附加 `response_format: { type: "json_object" }` 参数。[来源](src/ai/llm-client.ts#L64-L65)

为什么需要它？wiki-cli 在生成 Wiki 大纲时，要求 LLM 以 **严格 JSON 格式** 返回结果，这样才能可靠地解析为结构化数据。如果提供商支持 JSON mode，模型会更听话地输出合法 JSON。

wiki-cli 对每个提供商的处理策略不同：

| 行为 | 适用提供商 |
|------|-----------|
| **自动启用**（已知支持） | OpenAI、DeepSeek、xAI Grok、Mistral、Kimi (Moonshot) |
| **自动禁用**（已知不支持） | Google Gemini、Anthropic |
| **询问用户**（不确定） | Custom 模式 |

这种 **三态判断** 由 `supportsJsonMode()` 函数实现：对已知提供商直接判定，对自定义端点退回询问用户。[来源](src/config/config-store.ts#L22-L39)

> 深度阅读：关于 jsonMode 的底层实现和模型注册表的设计，见 [配置持久化与模型注册表](配置持久化与模型注册表.md)。

---

## 配置完成后的下一步

配置保存后，执行 `wiki-cli generate` 即可开始生成 Wiki 文档。完整的端到端流程请见：

- [快速开始](快速开始.md) — 5 分钟从安装到生成 Wiki
- [生成 Wiki 文档](生成-wiki-文档.md) — 理解生成过程的两阶段设计
- [命令行参考手册](命令行参考手册.md) — 所有命令的完整参考