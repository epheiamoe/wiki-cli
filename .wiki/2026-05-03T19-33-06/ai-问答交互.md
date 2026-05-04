# AI 问答交互

`wiki-cli ai` 命令将 LLM 引入代码仓库，让你可以在终端中以自然语言对话的方式探索代码。它支持两种运行模式、一套完整的会话管理系统，以及**优先读 Wiki、再探源码**的双层检索策略。

---

## 两种运行模式

### 单次问答模式

传入问题参数直接结束，适合快速查询：

```bash
wiki-cli ai "这个项目的目录结构是怎样的？"
wiki-cli ai "解释一下工具调用系统的核心流程"
```

LLM 收到问题后会调用可用工具（先读 Wiki 页面获取概览，再读源码验证细节），然后将结果直接输出到终端。问答结束后，本次对话会自动保存为一个会话，摘要取自问题文本前 60 个字符。[来源](../src/commands/ai.ts#L96-L103)

### 交互式模式

不带参数直接运行，进入持续对话：

```bash
wiki-cli ai
```

终端显示 `You >` 提示符，支持多轮追问。每轮对话后自动保存当前状态，退出前会再次确认保存。[来源](../src/commands/ai.ts#L108-L110)

两种模式的底层共享同一个 `chatOnce` 函数（第 113-188 行），区别仅在于是否进入 `interactiveLoop` 循环。

---

## 斜杠命令

交互式模式下支持以下斜杠命令。在 `You >` 提示符后输入 `/help` 可随时查看：

| 命令 | 用途 |
|------|------|
| `/exit` / `/quit` | 退出交互模式并保存会话 |
| `/save` | 手动保存当前会话 |
| `/clear` | 清屏 |
| `/session` | 显示当前会话 ID 和摘要 |
| `/sessions` | 列出所有保存的会话 |
| `/switch <id>` | 切换到指定会话 |
| `/new` | 创建新会话（当前会话自动保存） |
| `/wiki` | 触发生成 Wiki 文档 |
| `/help` | 显示以上命令列表 |

所有斜杠命令在 `interactiveLoop` 函数的 `if (input.startsWith('/'))` 分支中处理（第 203-268 行）。[来源](../src/commands/ai.ts#L203-L268)

---

## 会话持久化

### 存储位置

所有会话以 JSON 文件存于 `.wiki/sessions/` 目录，文件名格式为 `<8位ID>.json`。[来源](../src/ai/ai-session.ts#L17-L20)

### Session 数据结构

```typescript
interface Session {
  id: string;        // 8 位随机 ID
  created: string;   // ISO 时间戳
  updated: string;   // 最后更新时间
  summary: string;   // 会话摘要（取自第一条用户消息）
  messages: ChatMessage[];  // 完整消息历史
}
```

[来源](../src/ai/ai-session.ts#L5-L12)

### 生命周期

1. **创建**：调用 `createSession()` 生成新文件，`id` 由 `randomUUID().slice(0, 8)` 生成。[来源](../src/ai/ai-session.ts#L29-L38)
2. **保存**：每次对话后或手动 `/save` 时调用 `saveSession()`，更新 `updated` 时间戳后覆写文件。[来源](../src/ai/ai-session.ts#L65-L69)
3. **恢复**：`--session <id>` 或 `/switch <id>` 时调用 `loadSession()`，读取 JSON 后重建消息列表。值得注意的是，恢复时会重新注入当前系统提示词（`messages[0]`），保留历史用户与助手消息。[来源](../src/commands/ai.ts#L95-L100)
4. **列出**：`--list-sessions` 或 `/sessions` 调用 `listSessions()`，按更新时间倒序排列，跳过无法解析的损坏文件。[来源](../src/ai/ai-session.ts#L40-L54)
5. **删除**：`--delete-session <id>` 调用 `deleteSession()`，直接删除文件。[来源](../src/ai/ai-session.ts#L71-L76)

### 自动保存 vs 手动保存

交互模式下，**每轮用户消息之后**都会自动调用 `saveSession()`（第 282-285 行）。手动 `/save` 提供额外的安全网。退出前会再次保存，确保即使终端意外关闭，最多丢失最后一轮回答。[来源](../src/commands/ai.ts#L207-L210)

---

## AI 的检索策略：先 Wiki 后源码

系统提示词（`prompts/ai-system.md`）中明确规定了行为准则：

> 始终优先使用 Wiki 工具快速获取上下文，但最终答案必须基于实际代码验证。

具体的工具集分为两组：

**Wiki 工具**（优先使用）
- `list_wiki_pages` — 列出所有 Wiki 页面
- `read_wiki` — 按 slug 读取页面内容

**源码探索工具**（验证使用）
- `list_directory`、`list_files`、`read_file`、`search_in_files` — 文件系统操作
- `git_log`、`git_show`、`git_remote_info` — Git 历史查询
- `dotenv_template` — 环境变量模板

如果项目没有 Wiki，LLM 会被告知"该项目没有 Wiki"，仅使用源码工具。如果 Wiki 存在但信息与代码冲突，以代码为准。[来源](../prompts/ai-system.md#L1-L32)

工具定义和调度逻辑在 [`src/ai/tools.ts`](../src/ai/tools.ts) 中，`executeToolCall` 函数（第 296-303 行）按名称路由到对应处理函数。[来源](../src/ai/tools.ts#L296-L303)

---

## CLI 注册

`ai` 命令注册在 [`src/cli.ts`](../src/cli.ts) 第 58-66 行，支持参数：

```bash
wiki-cli ai [question]                 # 单次问答或交互模式
wiki-cli ai --session <id>             # 恢复会话
wiki-cli ai --list-sessions            # 列出会话
wiki-cli ai --delete-session <id>      # 删除会话
```

全部由 `aiCommand()` 函数统一处理，配置缺失时提示用户先运行 `wiki-cli config`。[来源](../src/cli.ts#L58-L66)

---

## 推荐阅读

- [交互式 AI 会话管理](交互式-ai-会话管理.md) — 会话管理的完整设计，包含多会话切换与历史回溯的深层机制
- [工具调用系统](工具调用系统.md) — 10 个只读工具的完整定义与执行链路
- [LLM 客户端核心实现](llm-客户端核心实现.md) — 流式与非流式通信、指数退避重试
- [提示词模板引擎](提示词模板引擎.md) — 外置 Markdown 提示词模板的渲染机制
- [配置你的 LLM 提供商](配置你的-llm-提供商.md) — 交互式配置 LLM 提供商与模型