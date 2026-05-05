# AI 问答

`wiki-cli ai` 是一个**与代码库对话的交互式命令行工具**。它利用 LLM（大语言模型）结合一套**只读工具**，让 AI 能够读取你的源码和 Wiki，回答关于项目结构、实现原理、配置方式等各种问题。

```bash
# 交互式聊天
wiki-cli ai

# 问单个问题
wiki-cli ai -q "项目使用了什么测试框架？"

# 只输出答案（适合脚本调用）
wiki-cli ai -q "项目的入口文件在哪？" -a
```

[来源](src/cli.ts#L112-L145)

---

## 三种工作模式

`aiCommand` 函数根据参数选择三种模式之一。

### 交互式循环（默认）

不带 `-q` 参数时进入 **交互式循环**。流程如下：

```
启动 → 检测工作目录 → 加载配置 → 检查 Wiki → 进入循环
                                              ↓
               ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
               ↓                               ↑
          用户输入 ← 斜杠命令 → 执行相应操作
               ↓                               ↑
          chatOnce() 流式问答 ← 自动保存 → → → → 
```

核心函数是 `interactiveLoop()`，它用 Node.js 的 `readline/promises` 创建循环，每轮接收用户输入，调用 `chatOnce()` 发送给 LLM，流式输出响应后自动保存会话。按下 `Ctrl+C` 或输入 `/exit` 退出。[来源](src/commands/ai.ts#L353-L478)

### 单次问答模式（`-q`）

带上 `-q` 参数时，AI 回答完**一个问题**后立即退出。回答分两种子模式：

| 子模式 | 参数 | 行为 |
|--------|------|------|
| 流式问答 | `-q "问题"` | 流式输出思考过程和答案（与交互式相同体验） |
| 仅输出答案 | `-q "问题" -a` | **非流式**，只打印最终答案文本，没有思考过程 |

`-a` 模式由 `answerOnly()` 函数处理，使用 `client.chat()`（非流式调用），结果直接 `console.log` 输出。适合在脚本中调用并捕获输出。[来源](src/commands/ai.ts#L160-L170)

无论哪种子模式，问答结束后都会保存会话并执行 `cleanup`。[来源](src/commands/ai.ts#L168-L172)

### 仅输出答案模式（`-a`）

`-a` 必须与 `-q` 搭配使用。它调用 `answerOnly()` 函数：

```typescript
async function answerOnly(
  client: LLMClient,
  messages: ChatMessage[],
  tools: typeof toolDefinitions,
  userInput: string
): Promise<string | null>
```

该函数**不流式输出**，而是在内部循环中反复调用 `client.chat()`——如果 LLM 返回了工具调用（tool_calls），自动执行工具并将结果喂回给 LLM；直到 LLM 返回纯文本答案为止。整个过程对用户透明，最终只输出纯答案文本。[来源](src/commands/ai.ts#L290-L349)

---

## 斜杠命令大全

在交互式循环中，输入以 `/` 开头的命令可以操作会话。

| 命令 | 功能 | 关键代码 |
|------|------|----------|
| `/exit` 或 `/quit` | 保存当前会话并退出 | [L377-L379](src/commands/ai.ts#L377-L379) |
| `/save` | 手动保存当前会话 | [L392-L395](src/commands/ai.ts#L392-L395) |
| `/undo` | 撤回上一条用户消息及其 AI 回复 | [L382-L390](src/commands/ai.ts#L382-L390) |
| `/clear` | 清屏 | [L397-L399](src/commands/ai.ts#L397-L399) |
| `/session` | 显示当前会话 ID 和摘要 | [L401-L403](src/commands/ai.ts#L401-L403) |
| `/sessions` | 列出当前项目的所有保存会话 | [L405-L408](src/commands/ai.ts#L405-L408) |
| `/switch <id>` | 切换到另一个会话（自动保存当前会话） | [L410-L443](src/commands/ai.ts#L410-L443) |
| `/wiki` | 调用生成命令重新生成 Wiki | [L454-L458](src/commands/ai.ts#L454-L458) |
| `/new` | 创建全新会话（自动保存当前会话） | [L445-L452](src/commands/ai.ts#L445-L452) |
| `/help` | 显示所有命令帮助 | [L372-L380](src/commands/ai.ts#L372-L380) |

### `/undo` 的工作原理

从 `messages` 数组末尾向前查找最后一条 `role === 'user'` 的消息，将其及其之后的所有消息（包括 AI 回复、工具调用结果）一并删除。因为 messages 第一项始终是 system prompt（索引 0），所以 `userIdx > 0` 才执行删除。[来源](src/commands/ai.ts#L382-L390)

### `/switch <id>` 的流程

1. 用 `saveSession()` 保存当前会话
2. 用 `loadSession(id)` 加载目标会话
3. 用已有 system prompt 拼接目标会话的消息
4. 恢复后直接继续对话[来源](src/commands/ai.ts#L410-L443)

---

## 工具调用：AI 如何读取源码和 Wiki

AI 之所以能回答代码相关问题，是因为它手中有 **13 个只读工具**（详见 [工具调用](工具调用.md)）。每次用户提问时，AI 经历以下循环：

```
用户提问 → LLM 分析 → 决定调用工具 → 执行工具 → 结果返回 LLM → LLM 继续推理
                                                              ↓
                                              直到 LLM 不再调用工具 → 输出最终答案
```

可用的工具分为三类：

**Wiki 工具**（优先使用）：
- `list_wiki_pages` — 列出所有 Wiki 页面
- `read_wiki` — 按 slug 读取 Wiki 页面
- `search_wiki` — 关键词搜索 Wiki
- `semantic_search` — 语义搜索 Wiki（需配置 Embedding）

**源码探索工具**：
- `list_directory` — 获取目录树
- `list_files` — 按扩展名列举文件
- `read_file` — 读取文件内容（可限制行范围）
- `search_in_files` — 在文件中搜索关键词/正则

**Git 工具**：
- `git_log` — 查看提交历史
- `git_show` — 查看提交详情
- `git_remote_info` — 查看远程仓库信息

**其他**：
- `dotenv_template` — 读取 `.env.example`
- `fetch_web_markdown` — 获取文档 URL 并转为 Markdown

### 工具执行机制

`chatOnce()` 在流式解析时逐步累积 `tool_call` 数据块。当一个完整的工具调用参数收集完毕后，调用 `executeToolCall(tc.function.name, args)` 执行，结果以 `role: 'tool'` 消息推回给 LLM。[来源](src/commands/ai.ts#L262-L286)

### 工具筛选

AI 启动时会根据项目状态动态隐藏不可用的工具：
- 没有 Wiki 时，隐藏所有 Wiki 工具
- 没有配置 Embedding 时，隐藏 `semantic_search`
- Web Fetch 被禁用时，隐藏 `fetch_web_markdown`[来源](src/commands/ai.ts#L118-L127)

---

## 流式输出与 Ctrl+C 中断

交互模式和 `-q` 模式都使用**流式 SSE** 输出。`chatOnce()` 通过 `client.chatStream()` 逐块接收 LLM 响应，实时打印给用户。[来源](src/commands/ai.ts#L218-L261)

中断机制通过 `SIGINT` 信号实现：

```typescript
// 设置中断标记
let streamingCancelled = false;
const sigHandler = () => { streamingCancelled = true; };
process.on('SIGINT', sigHandler);

try {
  await chatOnce(client, messages, tools, input, () => streamingCancelled);
} finally {
  process.removeListener('SIGINT', sigHandler);
}
```

在流式循环的每一轮迭代开始（外层 for 循环）和每个 chunk 处理前（内层 for-await），都会检查 `isCancelled?.()`。如果中断触发：
1. 已累积的文本被推入 messages
2. 打印 `⏹ (interrupted)` 提示
3. 返回已获得的部分内容[来源](src/commands/ai.ts#L222-L253)

---

## 会话管理

每次 AI 对话都是一个 **Session**，保存在 `.wiki/sessions/` 目录下。详情见 [会话管理系统](会话管理系统.md)。

### Session 结构

```typescript
interface Session {
  id: string;          // 8 位随机 UUID
  created: string;     // ISO 时间戳
  updated: string;     // 最后更新时间
  summary: string;     // 会话摘要（取第一条用户消息的前 60 字符）
  messages: ChatMessage[];  // 完整消息历史
}
```

[来源](src/ai/ai-session.ts#L11-L19)

### CRUD 操作

| 操作 | 函数 | 说明 |
|------|------|------|
| 创建 | `createSession()` | 生成 8 位 ID，写入 JSON 文件，并更新全局索引 |
| 读取 | `loadSession(id)` | 先查本地 `.wiki/sessions/`，再查跨项目索引 |
| 更新 | `saveSession(session)` | 刷新 `updated` 时间戳，写入 JSON |
| 删除 | `deleteSession(id)` | 删除本地文件并从全局索引移除 |
| 列表 | `listSessions()` | 列出当前项目的所有会话（按更新时间倒序） |
| 全局列表 | `listAllSessions()` | 通过全局索引列出所有项目的所有会话 |

[来源](src/ai/ai-session.ts#L46-L141)

### 全局索引

会话索引文件位于 `~/.wiki-cli/sessions-index.json`，格式为 `{ [sessionId]: sessionsDirPath }`。这让 `loadSession()` 能从**不同项目目录**恢复会话——即使你换到另一个项目，只要知道会话 ID，就能找回历史聊天。[来源](src/ai/ai-session.ts#L21-L44)

### 会话持久化时机

会话在以下时刻自动保存：
- 每轮交互结束后（`interactiveLoop` 末尾）
- 退出时（`/exit` 或 `Ctrl+C`）
- 切换会话前（`/switch`、`/new`）
- 单次问答模式回答完毕后

---

## 启动流程速览

当你执行 `wiki-cli ai` 时：

1. **解析工作目录** — 通过 `resolveWorkDir()` 处理 `-C`、`-u` 等参数
2. **加载配置** — `loadConfig()` 读取 LLM 配置
3. **检查特殊选项** — `--list-sessions`、`--delete-session` 等先于对话执行
4. **初始化 LLM 客户端和工具** — 配置 Embedding 和 Web Fetch
5. **检测 Wiki** — 如果 `.wiki/` 目录不存在，询问是否先生成
6. **构建系统 Prompt** — 从 `prompts/ai-system.md` 渲染，包含工作目录、Wiki 信息、可用工具说明
7. **加载/创建会话** — `--session <id>` 恢复历史会话，否则新建
8. **进入对应模式** — 交互循环、单次问答或仅输出答案

[来源](src/commands/ai.ts#L34-L184)

---

## 推荐阅读

- [工具调用](工具调用.md) — 13 个只读工具的完整定义和参数说明
- [会话管理系统](会话管理系统.md) — 深入理解会话 CRUD 和全局索引
- [LLM 客户端：流式与非流式](llm-客户端-流式与非流式.md) — 流式 SSE 解析和自动重试机制
- [配置文件详解](配置文件详解.md) — 如何配置 LLM、Embedding、Web Fetch
- [AI 聊天面板：浏览器内对话](ai-聊天面板-浏览器内对话.md) — 在浏览 Wiki 时也能聊天