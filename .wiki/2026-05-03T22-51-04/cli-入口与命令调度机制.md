# CLI 入口与命令调度机制

整个 CLI 的起点是 `src/cli.ts`，它是程序的主入口，承载了**命令注册**、**参数解析**和**错误边界**三层职责。所有子命令的 dispatch 逻辑都集中在这一文件中，而业务实现则委托给 `src/commands/` 目录下的独立模块。

## 引导层

文件开头的 shebang `#!/usr/bin/env node` 声明了运行时环境，使打包后的 `dist/cli.js` 可直接作为可执行文件调用。`package.json` 中的 `bin` 字段将 `wiki-cli` 命令映射到此文件，安装后即可全局调用。

```json
{
  "bin": { "wiki-cli": "dist/cli.js" }
}
```

[来源](src/cli.ts#L1)、[来源](package.json#L7-L9)

## Commander.js 初始化

`src/cli.ts` 以 `commander` 库的 `Command` 类为骨架，创建一个 `program` 实例，赋予它名称、描述和版本号：

```typescript
const program = new Command();
program
  .name('wiki-cli')
  .description('Auto-generate structured Wiki documentation for any local code repository')
  .version('1.0.0');
```

这三行等价于传给用户 `--help` 和 `--version` 的能力。Commander.js 会自动为顶层命令生成 `-V`、`--help` 等内置选项。

[来源](src/cli.ts#L7-L11)

## 四条子命令的注册模式

每条子命令的注册遵循相同的**链式调用**模板：`.command(name)` → `.description(text)` → `.option(...)`（可选）→ `.argument(...)`（可选）→ `.action(handler)`。下面逐一拆解。

### config：纯选项，无参数

```typescript
program
  .command('config')
  .description('Interactive configuration of LLM provider, model, API key, language')
  .option('--provider <provider>', 'LLM provider name')
  .option('--base-url <url>', 'API base URL')
  .option('--model <model>', 'Model name')
  .option('--api-key <key>', 'API key')
  .option('--lang <lang>', 'Documentation language (zh/en)')
  .action(async (options) => { ... });
```

所有选项都是 `--long-name <value>` 格式，无缩写形式，无默认值。当提供全部四个关键选项（provider、base-url、model、api-key）时，config 命令以非交互模式直接保存配置；否则进入 Inquirer 交互流程。详见 [配置命令](配置命令-wiki-cli-config.md)。

[来源](src/cli.ts#L13-L22)

### generate：缩写选项最密集

```typescript
program
  .command('generate')
  .description('Analyze repository and generate Wiki documentation')
  .option('-C, --dir <path>', 'Local repository directory (default: current directory)')
  .option('-u, --url <url>', 'Git repository URL to clone and generate')
  .option('-o, --output <path>', 'Clone destination path (with --url)')
  .option('-b, --branch <name>', 'Git branch (with --url)')
  .option('-d, --depth <n>', 'Git clone depth (with --url)')
  .option('-t, --temp', 'Temporary mode: clean up clone after done (with --url)')
  .option('-p, --parallel', 'Generate pages in parallel')
  .option('-c, --concurrency <n>', 'Number of concurrent page generations', '3')
  .option('-r, --retry <n>', 'Retry failed pages up to N times', '0')
  .option('-s, --silent', 'Silent mode: no interactive prompts, summary only')
  .action(async (options) => { ... });
```

这是四条命令中选项最多的一个：10 个选项，其中 9 个有短格式别名（如 `-C`、`-u`、`-p`）。两个选项 `--concurrency` 和 `--retry` 定义了**字符串默认值**——`'3'` 和 `'0'`。Commander.js 的 `option()` 第三参数会设置 `options.concurrency` 的默认值，但类型始终是 `string | undefined`，因此 action 内部需要手动转型。

[来源](src/cli.ts#L24-L38)

### browse：无选项，无参数

```typescript
program
  .command('browse')
  .description('Open generated Wiki in browser')
  .action(async () => { ... });
```

browse 是所有命令中最简单的，既没有 option 也没有 argument。action 不接受任何参数，直接调用 `browseCommand()`。服务端逻辑内置于 `src/commands/browse.ts`，负责查找 `.wiki` 目录下的最新生成记录，启动 HTTP 服务器并打开浏览器。详见 [浏览命令](浏览命令-wiki-cli-browse.md)。

[来源](src/cli.ts#L43-L46)

### ai：唯一同时使用 argument 和 option

```typescript
program
  .command('ai')
  .description('Interactive AI chat about the codebase')
  .argument('[question]', 'Optional question for single-answer mode')
  .option('-q, --question <text>', 'Question for single-answer mode')
  .option('-C, --dir <path>', 'Local repository directory (default: current directory)')
  // ... 更多选项
  .option('-a, --answer-only', 'Output only the final answer (no streaming, no thinking)')
  .action(async (question, options) => { ... });
```

ai 命令是唯一注册了 `.argument()` 的命令。`[question]` 使用方括号表示**可选参数**，未提供时为 `undefined`。它同时提供 `--question` 选项，action 内通过 `options.question || question` 将两者合并——当命令行参数和选项同时存在时，选项优先级更高。此外，它还包含了与 generate 相似的 Git 克隆选项体系（`-u/--url`、`-b/--branch`、`-d/--depth`、`-t/--temp`），并增加了会话管理专用的三个选项。

详见 [AI 交互命令](ai-交互命令-wiki-cli-ai.md)。

[来源](src/cli.ts#L50-L61)

## 四条命令的对比

| 维度 | config | generate | browse | ai |
|------|--------|----------|--------|----|
| argument 数量 | 0 | 0 | 0 | 1（可选） |
| option 数量 | 5 | 10 | 0 | 13 |
| 短格式别名 | 无 | 9 个 | — | 6 个 |
| 默认值选项 | 0 | 2（concurrency/retry） | 0 | 0 |
| action 签名 | `(options)` | `(options)` | `()` | `(question, options)` |
| parseInt 次数 | 0 | 3 | 0 | 1 |
| 业务入参接口 | `Partial<WikiCliConfig>` | `GenerateOptions` | 无 | `AiOptions` |

action 签名差异是 Commander.js 的规则使然：**只有定义了 `.argument()` 的命令，其 action 的第一个参数才是 argument 的值，其余情况均直接接收 `options` 对象**。browse 连 options 都没有，action 签名为空。

[来源](src/cli.ts#L22-L23)、[来源](src/cli.ts#L38-L40)、[来源](src/cli.ts#L46-L47)、[来源](src/cli.ts#L63-L65)

## parseInt：字符串到数字的手动转换

Commander.js 的所有选项值在解析后都是 `string | undefined`（或 `boolean` 对于无参数选项）。本项目不依赖 Commander 的内置类型转换（如 `.option('-c, --concurrency <n>', '...', parseInt)`），而是在 action 内部手动调用 `parseInt()`：

```typescript
concurrency: options.concurrency ? parseInt(options.concurrency) : 3,
retry: options.retry ? parseInt(options.retry) : 0,
depth: options.depth ? parseInt(options.depth) : undefined,
```

这种风格的原因有二：一是默认值逻辑与转型逻辑写在一起，意图更明确；二是 `depth` 的默认值是 `undefined` 而非固定数字，内置转型无法表达这种有条件的默认值。

[来源](src/cli.ts#L40-L42)、[来源](src/cli.ts#L66-L67)

## 统一的错误处理

四条命令的 action 共享完全相同的错误处理模板：

```typescript
try {
  await commandImplementation(options);
} catch (err: any) {
  logError(err.message);
  process.exit(1);
}
```

**三层结构**：
1. **try** — 执行业务函数的 `async` 调用
2. **catch** — 捕获任何运行时错误（网络超时、API 鉴权失败、文件系统错误等），通过 `logError` 以红色 `✖` 前缀输出到 stderr
3. **process.exit(1)** — 以非零退出码终止进程，防止程序在半错误状态下继续运行

`logError` 来自 `src/utils/progress.ts`，实现极简：

```typescript
export function logError(msg: string): void {
  console.log(chalk.red('✖'), msg);
}
```

这种全局错误兜底策略在各命令的实现模块内仍然保留了更细粒度的错误处理（如 generate 的重试逻辑仅在页面级别捕获，不会让整个命令崩溃），`src/cli.ts` 的 `try-catch` 是最后一道防线。

[来源](src/cli.ts#L24-L27)、[来源](src/utils/progress.ts#L18-L20)

## --help 与空参数兜底

文件末尾的两行代码处理了**无子命令**的情况：

```typescript
program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
```

`program.parse(process.argv)` 是 Commander.js 的标准入口——它读取 `process.argv`，匹配注册的命令和选项，触发相应的 action。如果用户仅输入 `wiki-cli` 而不带任何子命令（`process.argv.slice(2)` 为空数组），则调用 `program.outputHelp()` 将完整的帮助信息打印到终端，内容涵盖所有子命令的 name、description 和 option 列表。

这种设计比静默退出或报错"missing command"更友好——新用户首次运行 `wiki-cli` 时，看到的不是错误，而是一份完整的用法指引。

[来源](src/cli.ts#L72-L75)

## 设计要旨与 Commander.js 对照

对比 Commander.js 官方文档，本项目的 CLI 实现遵循了以下模式：

| 推荐实践 | 本项目实现 | 文件位置 |
|----------|-----------|----------|
| 使用 `.command()` 而非 `.addCommand()` | ✅ 采用链式 `.command().description().option().action()` | `src/cli.ts#L13-L69` |
| action 函数保持轻量 | ✅ 全部 action 仅做参数转型 + try-catch + 委托调用 | `src/cli.ts#L22-L68` |
| 解析后处理空参数 | ✅ `program.parse()` 后检测 `process.argv` 长度 | `src/cli.ts#L72-L75` |
| 选项解析后手动转型 | ✅ 使用 `parseInt` 而非 Commander 内置类型工厂 | `src/cli.ts#L40-L42` |

与官方示例的主要差异在于：Commander 推荐的选项类型转换方式是 `option('-c, --concurrency <n>', 'desc', parseInt)`，本项目选择了 action 内手动转型。这不是对错之分，而是项目团队的风格偏好——手动转型让默认值逻辑和类型转换写在同一行，便于一眼看出 `concurrency` 的 fallback 值是 `3`。

[来源](src/cli.ts#L38-L42)

---

## 下一步推荐阅读

- [配置命令](配置命令-wiki-cli-config.md) — config 命令的交互式与静默模式实现
- [生成命令](生成命令-wiki-cli-generate.md) — generate 命令的两阶段生成管线
- [浏览命令](浏览命令-wiki-cli-browse.md) — browse 命令的 HTTP 服务器实现
- [AI 交互命令](ai-交互命令-wiki-cli-ai.md) — ai 命令的对话与会话管理
- [进度显示与日志输出](进度显示与日志输出.md) — `logError` 及其姊妹函数的实现细节
- [概览](概览.md) — 项目整体架构与命令关系