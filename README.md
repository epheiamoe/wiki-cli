# 🔥 Wiki CLI

**One command.** Your entire codebase → beautifully structured Wiki, powered by LLM.

```bash
wiki-cli generate     # ✨ 生成
wiki-cli browse       # 📖 浏览
wiki-cli ai           # 💬 问答
wiki-cli tool-call    # 🔧 工具调用（给 AI agent 用）
```

---

## ✨ What makes this special?

| 能力 | 一句话 |
|------|--------|
| **任何 LLM** | OpenAI / DeepSeek / Claude / Gemini / Grok / Kimi / Mistral / 自定义，通吃 |
| **两阶段生成** | 先出大纲（JSON），再并发写页面——快且可控 |
| **流式输出** | AI 吐出每个字实时可见，还能看到推理过程 |
| **Tool Call** | LLM 自己调工具读源码、列目录、搜 Wiki，给答案带真实代码证据 |
| **断点续传** | Ctrl+C 中断？再跑一次从上次继续，不浪费 token |
| **语义搜索** | 可选 Embedding 模型注入，AI 问答时能搜 Wiki 找相关页面 |
| **会话管理** | AI 对话可 /save /undo /switch，退出时显示续行命令 |
| **远程仓库** | `--url git@github.com:xxx` 直接克隆并生成 |
| **本地浏览** | 内置 HTTP Server，语法高亮 + Mermaid 图表 + 版本切换 |
| **跨平台** | Windows / macOS / Linux 通杀 |

---

## 🚀 Quick Start

### 1. 配置

```bash
wiki-cli config
```

交互式选择：Provider → Model → API Key → 语言。

也可以跳过交互，一把梭：

```bash
wiki-cli config --provider DeepSeek --model deepseek-v4-flash --api-key sk-xxx --lang zh
```

只配 LLM 或只配 Embedding：

```bash
wiki-cli config --llm-only
wiki-cli config --embedding-only
```

配置保存到 `~/.wiki-cli/config.json`，一次配好到处用。

### 2. 生成 Wiki

```bash
# 当前目录（必须是 git 仓库）
wiki-cli generate

# 远程仓库
wiki-cli generate --url https://github.com/user/repo.git

# 指定分支（本地或远程）
wiki-cli generate -b main

# 并发生成（快 3-5 倍）
wiki-cli generate --parallel -c 5

# 生成完自动打开浏览器
wiki-cli generate --browse

# 静默模式，全自动
wiki-cli generate --silent --parallel --browse

# 输出到自定义目录
wiki-cli generate -o ./docs/wiki
```

两阶段内部流程：

```
Phase 1: 分析仓库 → LLM 生成大纲（JSON）
Phase 2: 逐个/并发生成页面 → 保存到 .wiki/<timestamp>/
```

如果网络不好、仓库没更新，会问你是不是要重新生成——不浪费你的 API 额度。

### 3. 浏览

```bash
# 当前项目的 Wiki
wiki-cli browse

# 指定路径
wiki-cli browse --path /path/to/project

# 缓存仓库（之前 --url 生成的）
wiki-cli browse --url https://github.com/user/repo.git
```

浏览器打开后：

- 左侧：导航目录（带难度标记 🟢🟡🔴）
- 右侧：渲染后的 Markdown，代码高亮
- `[来源：src/foo.ts#L12-L34]` 点开直接看源码（行号高亮）
- Mermaid 流程图自动渲染
- 顶部可切换历史版本

### 4. AI 问答

```bash
# 交互式
wiki-cli ai

# 一次性问答
wiki-cli ai "这个项目的架构是怎么样的？"

# 只输出答案（适合管道）
wiki-cli ai -a "解释 main 函数的逻辑"

# 恢复上次会话
wiki-cli ai --session <id>
```

交互式命令：

```
/exit /quit   退出（显示续行命令）
/undo         撤回上一条对话
/save         手动保存
/sessions     列出所有会话
/switch <id>  切换会话
/wiki         生成 Wiki
/new          新会话
```

问答中按 **Ctrl+C** 打断 AI 输出，不会退出会话。

如果有 Embedding 配置，AI 会自动搜 Wiki 找相关页面来回答问题。

### 5. Tool Call（给 AI agent 用）

```bash
# 列出可用工具
wiki-cli tool-call --help

# 调用工具，输出 JSON
wiki-cli tool-call semantic_search '{"query": "authentication"}'
wiki-cli tool-call read_wiki '{"slug": "project-architecture"}'
wiki-cli tool-call fetch_web_markdown '{"url": "https://example.com/docs"}'
```

任何支持 shell 执行的 AI agent（包括 opencode）都可以通过这个接口使用 wiki-cli 的内置工具：

| 工具 | 说明 |
|------|------|
| `semantic_search` | 语义搜索 Wiki（需配置 Embedding） |
| `fetch_web_markdown` | 抓取 URL 并转为 Markdown（Jina Reader） |
| `list_wiki_pages` | 列出所有 Wiki 页面 |
| `read_wiki` | 按 slug 读取 Wiki 页面 |
| `search_wiki` | 关键词搜索 Wiki |
| `list_directory` | 列出目录结构 |
| `list_files` | 按扩展名过滤文件 |
| `read_file` | 读取文件内容 |
| `search_in_files` | 全文搜索 |
| `git_log` / `git_show` / `git_remote_info` | Git 操作 |
| `dotenv_template` | 读取 `.env.example` |

输出纯 JSON 到 stdout，方便管道和脚本处理：

```json
{"type":"success","data":"...content..."}
```

---

## 🔧 支持的 LLM

| Provider | 推荐模型 | JSON 模式 |
|----------|----------|-----------|
| OpenAI | gpt-5.5, gpt-5.4-mini | ✅ |
| DeepSeek | deepseek-v4-flash, deepseek-v4-pro | ✅ |
| Anthropic | claude-sonnet-4-6, claude-haiku-4-5 | ❌ |
| Google Gemini | gemini-3.1-pro, gemini-3-flash | ❌ |
| xAI Grok | grok-4.3, grok-4-1-fast-reasoning | ✅ |
| Kimi (Moonshot) | kimi-k2.6 | ✅ |
| Mistral | mistral-large-3, devstral-2 | ✅ |

自定义 Provider：配 base URL 和模型名即可，支持不兼容 JSON 模式的模型。

---

## 📁 项目结构

```
wiki-cli/
├── src/
│   ├── cli.ts                     # 入口，Commander 注册所有命令
│   ├── commands/
│   │   ├── config.ts              # 交互式配置（LLM + Embedding）
│   │   ├── generate.ts            # 两阶段 Wiki 生成
│   │   ├── browse.ts              # 本地 HTTP 浏览服务器
│   │   └── ai.ts                  # AI 问答（会话/工具/Embedding）
│   ├── ai/
│   │   ├── llm-client.ts          # OpenAI 兼容客户端（流式+非流式）
│   │   ├── tools.ts               # 12 个只读工具（文件/git/wiki/search）
│   │   ├── embeddings.ts          # 语义搜索 + 缓存
│   │   ├── ai-session.ts          # 会话 CRUD
│   │   └── prompts.ts             # 渲染 prompt 模板
│   ├── config/
│   │   └── config-store.ts        # 配置持久化 + 模型列表
│   └── utils/
│       ├── file.ts                # 文件/时间戳/路径
│       ├── workspace.ts           # 工作目录解析（-C/-u/-o/-b）
│       ├── git.ts                 # 克隆/更新/checkout
│       └── progress.ts            # 进度显示
├── prompts/                       # prompt 模板（.md 解耦）
├── tests/                         # 71 个测试（vitest）
└── package.json
```

---

## 🧪 测试

```bash
# 跑全部
npm test

# 监视模式
npm run test:watch

# 当前覆盖率：71 tests, 6 test files
```

---

## 🧠 设计原则

- **Prompt 与代码分离**：所有 prompt 是独立的 `.md` 文件，不改代码也能调
- **只读工具**：LLM 只能读文件、列目录、搜代码，不改你的项目
- **JSON 大纲**：结构化的大纲让后续页面能互相引用，写出来的文档不孤立
- **缓存版本化**：Embedding 缓存带 `_model` 元数据，换模型自动重算
- **会话持久化**：AI 问答历史存在 `.wiki/sessions/`，随时恢复

---

## 📄 License

MIT © 2026 Epheia
