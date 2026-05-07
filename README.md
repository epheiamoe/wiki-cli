# 🔥 Wiki CLI

**One command.** Your entire codebase → beautifully structured Wiki, powered by LLM.

```bash
wiki-cli generate     # ✨ 生成 Wiki 文档
wiki-cli browse       # 📖 本地浏览（含 AI 问答面板）
wiki-cli ai           # 💬 代码库 AI 问答
wiki-cli status       # 📊 查看 Wiki 版本与代码差异
wiki-cli cache        # 📦 管理缓存的远程仓库
wiki-cli config       # ⚙️ 配置 LLM / Embedding / WebFetch
wiki-cli tool-call    # 🔧 工具调用接口（给 AI agent 用）
```

---

## ✨ 特性

| 能力 | 一句话 |
|------|--------|
| **任何 LLM** | OpenAI / DeepSeek / Claude / Gemini / Grok / Kimi / Mistral / 自定义 |
| **两阶段生成** | 先出结构化大纲，再并发写页面——快且可控 |
| **增量更新** | `--update` 只重新生成受 Git 变更影响的页面，不变页面直接复用 |
| **流式输出** | AI 吐出每个字实时可见，包含推理过程 |
| **Tool Call** | LLM 自己调工具读源码、列目录、搜 Wiki，答案附代码证据与行号 |
| **断点续传** | Ctrl+C 中断后重跑，从上次继续，不浪费 token |
| **语义搜索** | 可选 Embedding 模型注入，AI 问答自动检索 Wiki 页面 |
| **会话管理** | 保存/恢复对话历史，跨项目全局索引 |
| **远程仓库** | `--url` 直接克隆并生成，自动缓存至 `~/.wiki-cli/repos/` |
| **缓存管理** | `cache` 命令管理克隆仓库，删除时自动存档 Wiki 到 `wiki-archives/`，重新克隆自动恢复 |
| **临时模式** | `--temp` 一次性生成，完成后自动清理 |
| **本地浏览** | 内置 HTTP Server，代码高亮 + Mermaid 渲染 + 版本切换 + AI 问答侧边栏 |
| **跨平台** | Windows / macOS / Linux |

---

## 🚀 Quick Start

### 1. 配置

```bash
wiki-cli config
```

交互式选择：Provider → Model → API Key → 语言。也可一把梭：

```bash
wiki-cli config --provider DeepSeek --model deepseek-v4-flash --base-url https://api.deepseek.com --api-key sk-xxx --lang zh
```

单项配置（在已有配置基础上只改该项）：

```bash
wiki-cli config --llm-only
wiki-cli config --embedding-only
```

### 2. 生成 Wiki

```bash
# 当前目录（必须是 git 仓库）
wiki-cli generate

# 远程仓库（自动缓存）
wiki-cli generate --url https://github.com/user/repo.git

# 临时模式：一次性生成，用完即删
wiki-cli generate --url https://github.com/user/repo.git --temp

# 增量更新：只再生受代码变更影响的页面
wiki-cli generate --update

# 指定分支（本地或远程）
wiki-cli generate -b main

# 并发生成（快 3-5 倍）
wiki-cli generate --parallel -c 5

# 静默模式 + 全自动
wiki-cli generate --silent --parallel --browse
```

**两阶段流程：**

```
Phase 1:  分析仓库 → LLM 迭代探索（最多 25 轮 Tool Call）→ 输出 JSON 大纲
Phase 2:  并发/顺序生成每个页面 → 保存到 .wiki/<timestamp>/
          ─ 断点续传：已生成的页面自动跳过
          ─ 失败重试：最多 N 次重试 (--retry N)
```

### 3. 增量更新 (`--update`)

```bash
# 基于当前代码与上次生成之间的 git diff，只再生受影响的页面
wiki-cli generate --update
```

工作原理：

```
git diff <上次生成时的 commit>..HEAD
  → 提取变更文件的行号范围
  → 对比 .page-deps.json 中的文件依赖 → 定位受影响页面
  → Phase 1 Update: LLM 用 read_wiki 工具分析变更影响
  → Phase 2 Update: 未变更页面直接复制旧版本，仅再生受影响的页面
```

### 4. 浏览

```bash
# 当前项目 Wiki
wiki-cli browse

# 指定路径（项目目录 或 .wiki 目录 或版本目录）
wiki-cli browse --path /path/to/project

# 远程仓库的缓存 Wiki 或存档 Wiki
wiki-cli browse --url https://github.com/user/repo.git
```

浏览器打开后：

- 左侧：导航目录（带难度标记 🟢🟡🔴）
- 右侧：渲染后的 Markdown，代码高亮 + Mermaid 自动渲染
- `[来源：src/foo.ts#L12-L34]` 点开直接看源码（行号高亮）
- 右上角版本切换：浏览所有历史版本
- AI 侧边栏：与代码库对话（支持推理过程、工具调用、slash 命令）

### 5. AI 问答

```bash
# 交互式
wiki-cli ai

# 一次性问答
wiki-cli ai "这个项目的架构是怎么样的？"

# 只输出答案（适合管道）
wiki-cli ai -a "解释 main 函数的逻辑"

# 恢复上次会话
wiki-cli ai --session <id>

# 远程仓库
wiki-cli ai -u https://github.com/user/repo.git "authentication 流程"
```

交互式内建命令：

```
/help     显示帮助
/exit     退出（显示续行命令）
/undo     撤回上一条
/save     手动保存
/sessions 列出所有会话
/switch   切换会话
/new      新会话
/wiki     生成 Wiki
```

Ctrl+C 打断 AI 输出，不退出会话。配置 Embedding 后 AI 自动语义搜索 Wiki 页面。

### 6. 查看状态

```bash
# 查看当前 Wiki 与代码库的差异状态
wiki-cli status

# 指定版本
wiki-cli status -v 2026-05-07T19-23-03

# 显示详细变更日志
wiki-cli status --log
wiki-cli status --stat
```

输出展示：生成时间、分支、远程仓库、基于的 commit、落后 commit 数、最新/过时状态。

### 7. 缓存管理

```bash
# 交互式菜单（列出→选择→删除）
wiki-cli cache

# 列出所有缓存
wiki-cli cache --ls

# 删除指定缓存（默认 --keep-wiki：存档到 ~/.wiki-cli/wiki-archives/）
wiki-cli cache --rm <name>

# 清空所有缓存
wiki-cli cache --all

# 确认快速删除
wiki-cli cache --rm <name> -y
```

删除时 `--keep-wiki`（默认）将 Wiki 存档至 `~/.wiki-cli/wiki-archives/<name>/`。当通过 `--url` 重新克隆时，自动检测存档并询问是否恢复。

### 8. Tool Call（给 AI agent 用）

```bash
# 列出可用工具
wiki-cli tool-call --help

# 调用工具，输出 JSON
wiki-cli tool-call read_wiki '{"slug": "project-architecture"}'
wiki-cli tool-call semantic_search '{"query": "authentication"}'
wiki-cli tool-call fetch_web_markdown '{"url": "https://example.com/docs"}'
```

可用工具：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件（带行号前缀，支持大文件截断续传） |
| `list_directory` | 列出目录结构 |
| `list_files` | 按扩展名过滤文件 |
| `search_in_files` | 全文搜索 |
| `git_log` | Git 提交历史 |
| `git_show` | Git 提交详情 |
| `git_remote_info` | 远程仓库信息 |
| `dotenv_template` | 读取 `.env.example` |
| `semantic_search` | 语义搜索 Wiki（需 Embedding） |
| `fetch_web_markdown` | 抓取 URL 转 Markdown（Jina Reader） |
| `list_wiki_pages` | 列出 Wiki 页面 |
| `read_wiki` | 按 slug 读取 Wiki |
| `search_wiki` | 关键词搜索 Wiki |

输出纯 JSON：

```json
{"type":"success","data":"..."}
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

自定义 Provider：配置 Base URL + 模型名即可，支持不兼容 JSON 模式的模型。

---

## 📁 项目结构

```
wiki-cli/
├── src/
│   ├── cli.ts                     # 入口，Commander 注册所有命令
│   ├── commands/
│   │   ├── config.ts              # 交互式配置（LLM + Embedding + WebFetch + RepoDirs）
│   │   ├── generate.ts            # 两阶段生成 + 增量更新 + 断点续传 + 重试
│   │   ├── browse.ts              # HTTP 浏览服务器 + 渲染 + AI 侧边栏聊天
│   │   ├── ai.ts                  # 交互式/单次 AI 问答 + 会话管理
│   │   ├── status.ts              # Wiki 版本状态与 git 比较
│   │   ├── cache.ts               # 缓存仓库管理（ls / rm / archive）
│   │   └── tool-call.ts           # 工具执行接口（给 AI agent 用）
│   ├── ai/
│   │   ├── llm-client.ts          # OpenAI 兼容客户端（流式 + 非流式 + 重试）
│   │   ├── tools.ts               # 13 个只读工具
│   │   ├── embeddings.ts          # 语义搜索 + 模型版本化缓存
│   │   ├── ai-session.ts          # 会话 CRUD + 全局索引
│   │   └── prompts.ts             # 渲染 prompt 模板
│   ├── config/
│   │   └── config-store.ts        # 配置持久化 + 模型清单
│   └── utils/
│       ├── file.ts                # 文件/目录/时间戳/路径工具
│       ├── workspace.ts           # 工作目录解析（-C/-u/-o/-b/-t）+ 存档管理
│       ├── git.ts                 # 克隆/拉取/checkout + .gitignore 自动管理
│       ├── diff.ts                # git diff 解析 + 行号重叠检测（--update）
│       ├── progress-grid.ts       # 并行模式的 ANSI 进度显示
│       └── progress.ts            # 通用进度/日志输出
├── prompts/                       # prompt 模板（.md 解耦，不改代码也能调）
│   ├── ai-system.md               # AI 问答系统提示
│   ├── outline-system.md          # 大纲生成系统提示
│   ├── outline-user.md            # 大纲生成用户提示
│   ├── page-system.md             # 页面生成系统提示
│   ├── page-user.md               # 页面生成用户提示
│   ├── update-system.md           # 增量更新分析系统提示
│   └── update-user.md             # 增量更新分析用户提示
├── tests/                         # 71 个测试（vitest）
├── skills/                        # opencode agent skill
└── package.json
```

---

## 🧪 测试

```bash
npm test           # 跑全部（71 tests, 6 files）
npm run test:watch # 监视模式
```

---

## 🧠 设计原则

- **Prompt 与代码分离**：所有 prompt 是独立 `.md` 文件，不改代码也能调
- **只读工具**：LLM 只能读文件、列目录、搜代码，不修改你的项目
- **JSON 大纲**：结构化大纲让后续页面能互相引用，文档不孤立
- **缓存版本化**：Embedding 缓存带模型元数据，换模型自动重算
- **会话持久化** + 全局索引：本地 `.wiki/sessions/` + `~/.wiki-cli/sessions-index.json`
- **增量更新**：依赖追踪 + git diff 行号重叠，精准定位受影响页面
- **Wiki 存档**：删除缓存仓库时自动存档 Wiki，克隆时自动恢复
- **隐私保护**：`--temp` 模式用完即删，`.wiki/temp` 和 `sessions` 自动 gitignore

---

## 📄 License

MIT © 2026 Epheia
