# Prompt 模板系统

模板引擎是 Wiki CLI 中 Prompt 与代码解耦的关键机制。它将所有 LLM 指令文本存放在 `prompts/` 目录下的独立 Markdown 文件中，通过统一的 `renderPrompt` 函数在运行时加载并注入变量，使得 Prompt 的修改无需触及生成逻辑代码。

## 三层函数：加载 → 填充 → 渲染

`src/ai/prompts.ts` 暴露三个函数，从底向上组成一个简洁的管道：

```
loadPrompt(filename)    读取 prompts/ 下的模板文件
        │
fillPrompt(template, vars)   将 {{variable}} 替换为实际值
        │
renderPrompt(filename, vars)   = loadPrompt + fillPrompt
```

**`loadPrompt`** 接收文件名，使用 `fs.readFile` 从 `prompts/` 目录读取原始文本。目录路径通过 `resolve(__dirname, '..', '..', 'prompts')` 相对于模块位置计算，确保打包后也能正确定位。[来源](src/ai/prompts.ts#L1-L14)

**`fillPrompt`** 遍历 `PromptVars`（即 `Record<string, string>`），对每个键值对执行全局正则替换——将 `{{key}}` 替换为对应的值。正则表达式 `new RegExp('\\{\\{' + key + '\\}\\}', 'g')` 确保所有出现位置都被替换。[来源](src/ai/prompts.ts#L16-L24)

**`renderPrompt`** 作为便捷组合函数，先加载再填充，一步完成。所有外部调用者都使用此接口。[来源](src/ai/prompts.ts#L26-L30)

## 五个模板文件的职责分工

`prompts/` 目录下共 5 个模板文件，对应两阶段的生成管线和一个独立的 AI 问答模式：

| 模板文件 | 用途 | 调用方 | 注入变量 |
|---|---|---|---|
| `outline-system.md` | 大纲阶段系统指令 | `commands/generate.ts` 阶段一 | `workDir`, `os` |
| `outline-user.md` | 大纲阶段用户指令 | `commands/generate.ts` 阶段一 | `workDir`, `os`, `lang` |
| `page-system.md` | 页面阶段系统指令 | `commands/generate.ts` 阶段二 | `workDir`, `os`, `pageTitle`, `audienceLevel` |
| `page-user.md` | 页面阶段用户指令 | `commands/generate.ts` 阶段二 | `workDir`, `pageTitle`, `audienceLevel`, `pageSlug`, `projectSummary`, `lang`, `availablePages`, `pageTask` |
| `ai-system.md` | AI 问答模式系统指令 | `commands/ai.ts` | `workDir`, `os`, `wikiInfo`, `wikiTools` |

[来源](src/commands/generate.ts#L241-L244) [来源](src/commands/generate.ts#L543-L544) [来源](src/commands/ai.ts#L130-L130)

### 大纲阶段（两模板）

**`outline-system.md`** 定义了 LLM 的角色——资深软件工程师兼技术文档专家——并给出分析框架（高层愿景、架构剖析、受众分析）和严格的 JSON 输出格式。变量仅有 `workDir` 和 `os`，用于让 AI 了解工作环境。[来源](prompts/outline-system.md)

**`outline-user.md`** 是发给 LLM 的具体任务：探索项目、阅读关键文件、按框架分析、输出 JSON 目录。增加的 `lang` 变量控制输出语言。[来源](prompts/outline-user.md)

### 页面阶段（两模板）

**`page-system.md`** 定义写作角色——架构分析型技术作者——以及 Diátaxis 框架写作原则、视觉规范、证据标准和交叉引用规则。注入的 `pageTitle` 和 `audienceLevel` 让系统提示能感知当前正在写作的页面身份，给出针对性指令。[来源](prompts/page-system.md)

**`page-user.md`** 最复杂，携带 8 个变量。它通过 `pageTask` 传递对该页面的定制化写作任务，通过 `availablePages` 注入所有已有页面的元数据供交叉引用，通过 `pageSlug` 确定输出文件名。`lang` 控制输出语言，`projectSummary` 提供项目全局描述。[来源](prompts/page-user.md)

### AI 问答模式（单模板）

**`ai-system.md`** 为交互式问答设计。除了 `workDir`、`os`，还注入 `wikiInfo`（描述 Wiki 是否存在及版本数）和 `wikiTools`（动态生成的可选工具列表）。这使得 AI 在回答时能优先利用 Wiki 工具获取上下文，再深入代码验证。[来源](src/commands/ai.ts#L123-L130)

## 变量生命周期全景

```
┌─ commands/generate.ts (Outline Phase) ──────────────────────┐
│  outlineSysVars = { workDir, os }                           │
│  outlineUserVars = { workDir, os, lang }                    │
│  renderPrompt('outline-system.md', outlineSysVars)   ──►  system role │
│  renderPrompt('outline-user.md', outlineUserVars)     ──►  user role   │
└──────────────────────────────────────────────────────────────┘

┌─ commands/generate.ts (Page Phase) ─────────────────────────┐
│  pageSysVars  = { workDir, os, pageTitle, audienceLevel }   │
│  pageUserVars = { workDir, pageTitle, audienceLevel,        │
│                   pageSlug, projectSummary, lang,           │
│                   availablePages, pageTask }                │
│  renderPrompt('page-system.md', pageSysVars)        ──►  system role │
│  renderPrompt('page-user.md', pageUserVars)          ──►  user role   │
└──────────────────────────────────────────────────────────────┘

┌─ commands/ai.ts (AI Q&A Mode) ──────────────────────────────┐
│  aiSysVars = { workDir, os, wikiInfo, wikiTools }           │
│  renderPrompt('ai-system.md', aiSysVars)            ──►  system role │
└──────────────────────────────────────────────────────────────┘
```

## 设计哲学：Prompt 与代码解耦

将 Prompt 文本抽离为独立文件带来三个直接好处：

1. **修改 Prompt 无需改动 TypeScript 代码**——调整措辞、增加规则或修正输出格式时，只需编辑对应的 `.md` 文件，无需编译、无需改动生成逻辑。这在 Prompt 经常迭代的阶段尤为关键。
2. **模板变量作为契约接口**——每个模板文件只需通过 `{{variable}}` 声明自己需要哪些数据，调用方在 `renderPrompt` 时注入即可。这形成了一个清晰的**供应-消费契约**：`prompts/` 内的文件定义"我要什么"，`commands/` 内的代码定义"我给什么"。
3. **情境适应**——同一套模板引擎服务于两个截然不同的场景（文档生成与 AI 问答），通过注入不同的变量集使同一模板在不同上下文中表现不同。例如 `ai-system.md` 中的 `wikiTools` 在无 Wiki 时为空字符串，有 Wiki 时才展示工具列表。[来源](src/commands/ai.ts#L123-L130)

## {{variable}} 替换的边界情况

`fillPrompt` 使用 `String.replace` 配合全局正则，这意味着：

- 替换是**贪心且全局的**——同一变量在模板中出现多次会被全部替换。
- 如果 `PromptVars` 中缺少模板所需的某个变量，该 `{{variable}}` 会**原样保留**在输出中，不会被替换为空。这可以作为调试时检查缺失变量的快速手段。
- 变量名区分大小写——模板中的 `{{workDir}}` 与传入的 `{ workDir: '...' }` 必须完全匹配，`{{workdir}}` 不会被识别。[来源](src/ai/prompts.ts#L19-L24)

## 相关页面

- [两阶段生成引擎](两阶段生成引擎.md) 详细展示了模板在 outline 和 page 两个阶段中的调用时序。
- [AI代码问答](ai代码问答.md) 说明 `ai-system.md` 在交互式会话中的使用场景。
- [LLM客户端设计](llm客户端设计.md) 介绍接收已填充 Prompt 的 LLM 流式客户端实现。