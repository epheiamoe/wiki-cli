# 测试策略与 Vitest 配置

## 配置哲学：全局注入 + Node 环境

项目的测试基础设施基于 **Vitest 2.1.8**，配置存放在 `vitest.config.ts` 中，仅有三行核心设定：

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

[来源](vitest.config.ts#L1-L10)

**`globals: true`** 意味着测试文件中不必手动导入 `describe`、`it`、`expect`、`vi` 等全局函数——它们是自动注入的。这一决策降低了测试文件的仪式性开销，使测试代码聚焦于断言逻辑本身。所有测试文件也确实依赖这一特性：没有任何文件从 `'vitest'` 导入全局函数（config-store 等文件虽然写了 `import { describe, it, expect } from 'vitest'`，这只是为了 TypeScript 类型推导，实际运行中 globals 注入优先）。

**`environment: 'node'`** 则确保测试运行在 Node.js 环境下而非 jsdom 或 happy-dom 浏览器模拟环境。由于项目是纯 CLI 工具，不涉及 DOM 操作，选择 Node 环境避免了不必要的浏览器 polyfill，且能直接使用 `node:fs`、`node:os` 等原生模块——这在 `file.test.ts` 中以临时目录进行文件操作、在 `llm-client.test.ts` 中 mock `globalThis.fetch` 时尤为关键。

测试文件的匹配模式 `tests/**/*.test.ts` 将全部 6 个测试文件限定在 `tests/` 目录下。

---

## 测试文件全景

六个测试文件覆盖了项目六个核心模块，彼此独立、各司其职：

| 测试文件 | 被测模块 | 核心关注点 |
|----------|----------|-----------|
| `config-store.test.ts` | `src/config/config-store.ts` | 配置数据结构的完整性 |
| `file.test.ts` | `src/utils/file.ts` | 文件系统的正确性与边界 |
| `llm-client.test.ts` | `src/ai/llm-client.ts` | 网络通信、流式解析、重试 |
| `outline-parser.test.ts` | `src/ai/llm-client.ts`（`parseOutlineJson`） | JSON 解析的多级容错 |
| `prompts.test.ts` | `src/ai/prompts.ts` | 模板引擎的变量替换 |
| `tools.test.ts` | `src/ai/tools.ts` | 工具注册与执行器的正确性 |

[来源](tests/config-store.test.ts#L1-L3)、[来源](tests/file.test.ts#L1-L4)、[来源](tests/llm-client.test.ts#L1-L4)、[来源](tests/outline-parser.test.ts#L1-L3)、[来源](tests/prompts.test.ts#L1-L3)、[来源](tests/tools.test.ts#L1-L5)

---

## config-store.test.ts：配置持久化的完整性

该文件验证 `default-models.json` 的数据结构是否符合预期。测试不 mock 任何内容，直接读取真实的 JSON 文件进行断言。

**核心测试用例：**

- **验证 JSON 合法性**：确保文件可解析为数组
- **条目数量下限**：至少 20 个模型条目——这一约束保证了内置提供商的基本覆盖
- **必要字段检查**：每个条目必须包含 `provider`、`model`、`baseUrl`、`description`
- **提供商完整性**：通过 `getProviders()` 验证是否存在全部 7 个预定义提供商（OpenAI、Google Gemini、Anthropic、xAI Grok、DeepSeek、Kimi、Mistral）
- **关键模型存在性**：检查 `gpt-5.5`、`gemini-3.1-pro`、`claude-opus-4-7` 等特定模型名
- **过滤逻辑正确性**：`getModelsByProvider()` 按提供商过滤时，结果集的 `provider` 字段应完全匹配
- **供应商去重**：`getProviders()` 不应返回重复元素

[来源](tests/config-store.test.ts#L1-L67)

---

## file.test.ts：文件操作的真实读写

测试直接操作文件系统——使用 `mkdtempSync` 创建临时目录，测试完毕不清理（利于失败时人工检查残留）。这种"留存式"策略在 CI 环境中可接受，因临时目录会被系统清理。

**核心测试用例：**

- **`ensureDir` 递归创建目录**：验证 `a/b/c` 多级目录能一次建立
- **`writeTextFile` + `readTextFile` 的读写一致性**：写入 `'Hello World'` 后读回内容严格相等
- **`removeDir` 递归删除**：嵌套文件 `toremove/nested/file.txt` 所在目录可被整体移除
- **`toSlug` Slug 转换的边界**：
  - 中文标题按原样保留（`'概览'` → `'概览'`）
  - 英文标题转为小写并用连字符连接（`'Quick Start Guide'` → `'quick-start-guide'`）
  - 中英文混合保留字母数字与中文（`'Hello 世界'` → `'hello-世界'`）
  - 多重分隔符合并为单字符（`'a   b---c'` → `'a-b-c'`）
  - **空输入**返回 `'untitled'` —— 这是典型的边界降级策略
  - 首尾分隔符被剥离（`'  hello world  '` → `'hello-world'`）
  - **特殊字符**被替换为连字符（`'test@#$file!'` → `'test-file'`）
- **`getTimestamp` 时间戳格式验证**：正则匹配 `YYYY-MM-DDTHH-MM-SS` 格式，且年份为当前年份

[来源](tests/file.test.ts#L1-L68)

---

## llm-client.test.ts：网络通信的完整模拟

这是六个文件中测试用例最多的文件，覆盖了 **LLMClient** 的流式/非流式通信、重试策略、错误处理三大维度。核心策略是：mock `globalThis.fetch`，手工构造 SSE（Server-Sent Events）流或 HTTP 响应。

**核心测试用例：**

| 测试场景 | 模拟对象 | 验证点 |
|----------|----------|--------|
| 流式输出 content 块 | SSE 流，两段 delta content | `yield` 出 `type: 'content'` 和 `type: 'done'` |
| 流式输出 tool_call 块 | SSE 流含 `tool_calls`+`function` | `yield` 出 `type: 'tool_call'` |
| 流式输出 reasoning 块 | SSE 流含 `reasoning_content` | `yield` 出 `type: 'reasoning'` 且内容拼接正确 |
| HTTP 401 错误 | `ok: false, status: 401` | 产出 `type: 'error'` 块 |
| 非流式 chat 请求格式 | 捕获请求体 JSON | 验证 `model`、`messages`、`tools` 字段 |
| `reasoning_content` 回传 | 捕获请求体中 assistant 消息 | `reasoning_content` 字段保留 |
| **5xx 重试（非流式）** | 第一次 503，第二次成功 | 调用 2 次，最终得到内容 |
| **5xx 重试（流式）** | 第一次 502，第二次成功 | 调用 2 次，最终 `done` 块 |
| **网络错误重试** | 前 2 次抛出 `ECONNRESET`，第 3 次成功 | 调用 3 次，`timeout: 15000` |
| **4xx 不重试** | 401 非流式 | 仅调用 1 次，产出 `error` |
| baseUrl 拼接 | 捕获请求 URL | 验证拼接为 `https://api.test.com/v1/chat/completions` |

**边界条件**集中在重试逻辑：测试区分了"可重试"（5xx 服务端错误、ECONNRESET 网络错误）和"不可重试"（4xx 客户端错误）两类场景，且验证了重试次数。流式与非流式两种通信模式各自有独立的重试测试用例。

[来源](tests/llm-client.test.ts#L1-L153)

---

## outline-parser.test.ts：JSON 解析的多级容错

大纲解析是整个生成管线中最脆弱的环节——LLM 的输出可能包含代码围栏、前置/后置文字、甚至是完全无效的 JSON。该文件测试了一个辅助函数 `parseOutlineJson`（位于 `src/ai/llm-client.ts`）和一个底层函数 `stripCodeFence`。

**核心测试用例：**

**常规解析路径：**
- 标准 JSON 格式正确解析出 4 个 topic，含 section 分组、`isGroup` 标记、description/task 字段
- group 类型条目正确设置 `isGroup: true`、level 为空字符串
- `description` 和 `task` 字段从 `brief` 字段自动回退

**容错场景（边界条件）：**
- **代码围栏包裹**：JSON 被 ```` ```json ```` 包裹仍能正确解析
- **额外文字环绕**：JSON 前后存在自然语言说明文字（如 `"Here is the result:"`）
- **空字符串输入**：返回空数组
- **非 JSON 文本**：返回空数组
- **结构错误**：`{"wrong": "structure"}` 无 `sections` 字段 → 返回空数组
- **缺失字段回退**：topic 没有 `description`/`task` 时从 `brief` 取；既无 `description` 也无 `brief` 时返回空字符串

**`stripCodeFence` 单独测试：**
- 移除 ```` ```json ```` 围栏
- 移除 ```` ``` ```` 围栏（无语言标记）
- 无围栏时原文返回

[来源](tests/outline-parser.test.ts#L1-L107)

---

## prompts.test.ts：模板渲染的变量替换

`fillPrompt` 函数是提示词模板引擎的核心，采用 `{{变量名}}` 插值语法。测试全部为纯函数式测试，无任何副作用。

**核心测试用例：**

- **单变量替换**：`'Hello {{name}}'` + `{name: 'World'}` → `'Hello World'`
- **多变量替换**：同时替换 `greeting` 和 `name`
- **变量复用**：同一变量在模板中出现多次（`{{x}} + {{x}} = {{y}}`）
- **未定义变量保留**：`var` 缺少映射时，`{{var}}` 原样保留（不做空替换也不报错）
- **空模板**：空字符串入参返回空字符串
- **空变量对象**：无参模板只返回静态文本
- **中文字符值**：`{{lang}}` 替换为 `'中文'` 正常渲染

[来源](tests/prompts.test.ts#L1-L33)

---

## tools.test.ts：工具注册与执行器的双面验证

该文件验证了工具系统的两个层面：**注册层**（`toolDefinitions` 的结构完整性）和**执行层**（`executeToolCall` 的实际行为）。测试创建真实临时目录并写入示例文件，模拟工作区环境。

**核心测试用例（注册层）：**
- `toolDefinitions` 是数组，长度恰好为 **10**（对应 8 个只读工具 + 2 个 Wiki 工具）
- 包含所有 10 个工具名：`list_directory`、`list_files`、`read_file`、`search_in_files`、`git_log`、`git_show`、`git_remote_info`、`dotenv_template`、`list_wiki_pages`、`read_wiki`
- 每个工具的 `parameters.type` 必须为 `'object'`——这是 OpenAI Function Calling 的强制要求

**核心测试用例（执行层）：**
- **成功路径**：`list_files` 列出目录、按 `.ts` 后缀过滤、`read_file` 按行范围读取
- **搜索匹配**：`search_in_files` 找到含 `'hello'` 的文件
- **搜索无匹配**：不存在的模式返回空数组（不是错误）
- **目录树**：`list_directory` 返回树结构
- **错误路径**：
  - `read_file` 不存在文件 → `type: 'error'`
  - `list_files` 不存在目录 → `type: 'error'`
  - **未知工具名** → `type: 'error'`
  - **缺少必要参数**：`list_directory` 缺 `dir_path` → error 含 `'dir_path'` 提示
  - **缺少 `file_path`** → error 含 `'file_path'` 提示
  - **缺少 `slug`** → error 含 `'slug'` 提示
- **装饰性验证**：`list_wiki_pages` 和 `read_wiki` 调用不会崩溃——结果可能是 `success` 或 `error`，但不抛异常

[来源](tests/tools.test.ts#L1-L132)

---

## 整体设计观察

从 6 个测试文件中可以提炼出三条一致的策略原则：

1. **真实操作 vs 模拟**：文件操作（`file.test.ts`、`tools.test.ts`）使用真实临时目录，避免 mock 文件系统的复杂性；网络通信（`llm-client.test.ts`）mock `fetch` 而不是真正调用 API，保证测试的可靠性与速度；配置数据（`config-store.test.ts`）读取真实 JSON 文件，将数据结构定义作为契约测试。

2. **边界优先于路径覆盖**：每个测试文件都包含至少一个"空输入"或"无效输入"用例——空字符串、不存在文件、404 响应、缺失参数。这些边界条件在实际运行中比标准路径更容易导致生产故障。

3. **纯函数与副作用分离**：`prompts.test.ts` 和 `outline-parser.test.ts` 测试纯函数，无 setup/teardown；`llm-client.test.ts` 和 `tools.test.ts` 需要 beforeEach/afterEach 恢复全局状态。这一分离使得纯函数测试可并行执行且永不相互干扰。

脚本入口提供了 `npm test`（`vitest run`，单次运行）和 `npm run test:watch`（`vitest`，监视模式）两种模式，分别适配 CI 和开发迭代场景。

[来源](package.json#L10-L11)

---

## 下一步推荐阅读

- [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) —— 理解生成管线如何调用被测试的核心模块
- [LLM 客户端：流式通信与重试机制](llm-客户端-流式通信与重试机制.md) —— `llm-client.test.ts` 背后的实现细节
- [工具系统：LLM 只读探索工具的设计](工具系统-llm-只读探索工具的设计.md) —— 10 个工具的完整设计与 `tools.test.ts` 的对应关系
- [提示词模板引擎：解耦的模板渲染](提示词模板引擎-解耦的模板渲染.md) —— `fillPrompt` 的实现与应用场景