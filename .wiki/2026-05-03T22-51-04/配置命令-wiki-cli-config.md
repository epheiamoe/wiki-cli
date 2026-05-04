# 配置命令：wiki-cli config

在使用 Wiki CLI 生成文档之前，你必须先配置一个 **LLM 提供商**——它是驱动文档生成的"引擎"。`wiki-cli config` 命令就是用来完成这项设置的。

## 两种配置方式

根据你是**首次使用**还是**脚本自动化**，可以选择不同模式。

### 交互式模式（推荐新手）

直接运行 `wiki-cli config`，不加任何参数，工具会启动一个**交互式向导**，通过提问引导你完成全部配置：

1. **选择 LLM 提供商** —— 从内置的 7 家提供商中选一个，或选择自定义
2. **选择模型** —— 在上一步选定的提供商下，选择一个具体的模型
3. **输入 API Key** —— 输入你的 API 密钥（输入时用 `*` 掩码显示，安全第一）
4. **确认 JSON 输出模式** —— 如果是自定义提供商，会询问是否支持 JSON 模式
5. **设置文档语言** —— 默认 `zh`，可改为 `en`

每一步都有默认值预填（如果之前配置过），直接回车即可沿用。

[来源](src/commands/config.ts#L29-L93)

### 命令行模式（适合自动化或高级用户）

如果你已经清楚要使用哪个提供商和模型，可以用一条命令完成配置，无需任何交互：

```
wiki-cli config --provider OpenAI --base-url https://api.openai.com/v1 --model gpt-5.4 --api-key sk-xxxx
```

这种方式需要同时提供 `--provider`、`--base-url`、`--model`、`--api-key` 四个参数。可选参数 `--lang` 用于指定文档语言（`zh` 或 `en`）。

当检测到这四个关键参数全部传入时，工具会直接保存配置并退出，不会进入交互界面。

[来源](src/commands/config.ts#L12-L21)

---

## 内置的 7 个提供商和 21 个模型

配置文件 `src/config/default-models.json` 中内置了以下提供商和模型：

| 提供商 | 包含的模型 |
|--------|-----------|
| **OpenAI** | gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5-mini |
| **Google Gemini** | gemini-3.1-pro, gemini-3-flash, gemini-3.1-flash-lite |
| **Anthropic** | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 |
| **xAI Grok** | grok-4.3, grok-4.20-reasoning, grok-4-1-fast-reasoning |
| **DeepSeek** | deepseek-v4-pro, deepseek-v4-flash |
| **Kimi (Moonshot)** | kimi-k2.6, kimi-k2.5 |
| **Mistral** | mistral-large-3, devstral-2, ministral-14b |

交互式向导中，每个模型后面会附带价格提示（如 "Most expensive, highest quality"），帮助你做出权衡。

[来源](src/config/default-models.json)

---

## JSON 模式的自动推断逻辑

**JSON 模式**（`response_format: json_object`）是生成管线中请求 LLM 返回结构化 JSON 的必要能力。配置时会自动判断当前提供商是否支持：

- **已知支持的提供商**（返回 `true`）：OpenAI、DeepSeek、xAI Grok、Mistral、Kimi (Moonshot) —— 直接启用，不询问用户
- **已知不支持的提供商**（返回 `false`）：Google Gemini、Anthropic —— 直接禁用，不询问用户
- **自定义提供商**（返回 `undefined`）：工具无法预知，会弹出一个确认问题让你手动选择

这个逻辑集中在 `supportsJsonMode()` 函数中，以硬编码的 Set 实现：

```typescript
const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
]);
```

[来源](src/config/config-store.ts#L17-L24)

---

## 自定义提供商支持

如果你的 LLM 不在内置列表中，可以选择 **"✏️ Custom (enter manually)"** 选项，然后手动输入：

- **Base URL**：API 端点地址
- **Model name**：模型名称（如 `gpt-4`、`claude-3-opus` 等任意字符串）

自定义模式会跳过模型选择列表，直接让你输入。同时，由于工具无法预知你的自定义提供商是否支持 JSON 模式，会额外弹出一个确认问题。

[来源](src/commands/config.ts#L42-L51)

---

## 配置存储位置

所有配置最终保存在用户主目录下的 JSON 文件中：

```
~/.wiki-cli/config.json
```

在 Windows 上，`~` 对应 `C:\Users\<用户名>\`。文件内容大致如下：

```json
{
  "provider": "OpenAI",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-5.4",
  "apiKey": "sk-xxxx",
  "lang": "zh",
  "jsonMode": true
}
```

工具在保存时会自动创建 `~/.wiki-cli` 目录（如果不存在），然后写入 `config.json`。配置写入成功后，终端会显示 "Configuration saved to..." 的确认信息。

[来源](src/config/config-store.ts#L10-L11)

---

## 下一步推荐阅读

- [快速开始](快速开始.md) —— 配置完成后，5 分钟跑通完整流程
- [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) —— 理解文档生成的两阶段过程
- [LLM 提供商与模型注册](llm-提供商与模型注册.md) —— 深入了解每个提供商和模型的注册逻辑
- [添加新的 LLM 提供商](添加新的-llm-提供商.md) —— 如果需要添加 default-models.json 中没有的提供商
- [CLI 入口与命令调度机制](cli-入口与命令调度机制.md) —— 了解所有命令的注册和参数解析细节