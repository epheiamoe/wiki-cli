# CLI 入口点与命令注册

`src/cli.ts` 是整个 `wiki-cli` 的启动文件，也是用户与工具交互的第一道门槛。它使用 **Commander.js** 库构建命令行界面，定义了程序的元信息、注册四条核心命令、统一处理异步错误，并自动兜底帮助输出。理解这个文件的设计，就抓住了整个工具的控制流骨架。

---

## 程序实例：元信息与版本标识

脚本首先创建 `Command` 实例，然后通过链式调用设置名称、描述和版本号：

```typescript
const program = new Command();
program
  .name('wiki-cli')
  .description('Auto-generate structured Wiki documentation for any local code repository')
  .version('1.0.0');
```

`.version('1.0.0')` 会自动注册 `--version` 和 `-V` 选项（Commander.js 内置行为），用户执行 `wiki-cli --version` 时输出 `1.0.0`。版本号与 `package.json` 中的 `version` 字段保持同步。

[来源](src/cli.ts#L1-L12)

---

## 四条命令的注册模式

`program.command(name)` 定义子命令，`.description()` 说明用途，`.option()` 声明可接收的参数，最后 `.action()` 绑定执行回调。四条命令的注册结构完全一致，形成统一的**声明式注册模式**。

### 命令总览

| 命令 | 描述 | 是否有参数/选项 | action 回调签名 |
|------|------|-----------------|-----------------|
| `config` | 交互式配置 LLM | 5 个 option（`--provider`, `--base-url`, `--model`, `--api-key`, `--lang`） | `async (options) => {...}` |
| `generate` | 分析并生成 Wiki | 无 option | `async () => {...}` |
| `browse` | 浏览器浏览 Wiki | 无 option | `async () => {...}` |
| `ai` | AI 交互问答 | 1 个 argument（`[question]`）+ 3 个 option（`--session`, `--list-sessions`, `--delete-session`） | `async (question, options) => {...}` |

[来源](src/cli.ts#L14-L60)

### config 命令：纯选项驱动

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

五个 option 均为可选的具名参数，若不提供则进入交互式提示（由 `inquirer` 驱动）。`options` 对象会包含所有传入的选项值，未指定的字段为 `undefined`。详见 [配置命令：wiki-cli config](配置命令-wiki-cli-config.md)。

[来源](src/cli.ts#L14-L32)

### generate 与 browse 命令：无参数执行

```typescript
program
  .command('generate')
  .description('Analyze current repository and generate Wiki documentation')
  .action(async () => { ... });

program
  .command('browse')
  .description('Open generated Wiki in browser')
  .action(async () => { ... });
```

这两条命令不接受任何命令行参数——`generate` 所需的配置来自配置文件（通过 [配置存储与高级选项](配置存储与高级选项.md) 读取），`browse` 默认启动 HTTP 服务后自动打开浏览器。详见 [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) 和 [浏览命令：wiki-cli browse](浏览命令-wiki-cli-browse.md)。

[来源](src/cli.ts#L34-L47)

### ai 命令：参数 + 选项的混合注入

```typescript
program
  .command('ai')
  .description('Interactive AI chat about the codebase')
  .argument('[question]', 'Optional question for single-answer mode')
  .option('--session <id>', 'Resume a specific session')
  .option('--list-sessions', 'List all saved sessions')
  .option('--delete-session <id>', 'Delete a session')
  .action(async (question, options) => { ... });
```

`ai` 是唯一同时使用 `.argument()` 和 `.option()` 的命令。Commander.js 的 **action 参数注入顺序**规则为：先传入参数（arguments，按声明顺序），再传入选项（options）对象。因此回调签名为 `(question, options)`，其中 `question` 对应 `[question]` 参数的值（未提供时为 `undefined`），`options` 包含 `session`、`listSessions`、`deleteSession` 三个选项。详见 [AI 交互命令：wiki-cli ai](ai-交互命令-wiki-cli-ai.md)。

[来源](src/cli.ts#L49-L60)

---

## 统一的异步错误处理模式

四条命令的 `.action` 回调采用了完全相同的 `try-catch` 结构：

```typescript
.action(async (...args) => {
  try {
    await actualCommand(...args);
  } catch (err: any) {
    logError(err.message);
    process.exit(1);
  }
});
```

这里有三层设计意图：

1. **异步支持**：所有 `.action` 都标记为 `async`，因为四条命令的实现函数（`configCommand`、`generateCommand`、`browseCommand`、`aiCommand`）均返回 `Promise`。这让 Commander.js 能够正确等待异步操作完成。

2. **集中错误兜底**：`catch` 块调用 `logError`（来自 `src/utils/progress.ts`，使用 `chalk.red` 输出错误前缀 `✖`），然后 `process.exit(1)` 以非零状态码退出进程。这确保任何未预料的错误都不会被静默吞掉。

3. **用户可见的反馈**：`logError` 输出的红色 `✖` 符号在终端中一目了然，与 `logSuccess` 的绿色 `✔`、`logInfo` 的蓝色 `ℹ` 构成统一的反馈体系（详见 [整体架构与模块划分](整体架构与模块划分.md) 的工具层说明）。

> **注意对比**：虽然所有 action 都是 `async`，但 `config`、`generate`、`browse` 对应的实现函数（`configCommand`, `generateCommand`, `browseCommand`）内部也可能包含同步逻辑。`async` 关键字只是让这些函数在遇到 `await` 时不会阻塞事件循环。

[来源](src/cli.ts#L24-L31) [来源](src/utils/progress.ts#L19-L21)

---

## 自动帮助兜底

文件末尾有两行关键的兜底逻辑：

```typescript
program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
```

`program.parse(process.argv)` 解析用户输入的命令行参数。如果用户没有传入任何参数（`process.argv.slice(2).length === 0`），则自动调用 `program.outputHelp()` 输出完整的帮助信息——包含所有子命令列表、选项说明和用法示例。这比 Commander.js 默认的 `--help` 更友好：用户在未输入任何命令时不会得到静默提示或错误，而是直接看到引导性的帮助文本。

[来源](src/cli.ts#L62-L66)

---

## 依赖关系图

```
src/cli.ts
  ├── commander        → Command, program.parse()
  ├── commands/config  → configCommand
  ├── commands/generate → generateCommand
  ├── commands/browse  → browseCommand
  ├── commands/ai      → aiCommand
  └── utils/progress   → logError
```

`cli.ts` 不包含任何业务逻辑——它的职责是"注册与分发"。四条命令的实际实现在 `src/commands/` 目录中，分别对应 [配置命令：wiki-cli config](配置命令-wiki-cli-config.md)、[生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md)、[浏览命令：wiki-cli browse](浏览命令-wiki-cli-browse.md) 和 [AI 交互命令：wiki-cli ai](ai-交互命令-wiki-cli-ai.md) 的详细说明。

---

## 推荐阅读

- [整体架构与模块划分](整体架构与模块划分.md) —— 从更高视角看 cli.ts 在四层架构中的位置
- [配置命令：wiki-cli config](配置命令-wiki-cli-config.md) —— config 命令的交互式配置实现
- [生成命令：wiki-cli generate](生成命令-wiki-cli-generate.md) —— generate 命令的两阶段生成流程
- [错误处理与日志体系](错误处理与日志体系.md) —— `logError` 等工具函数的完整设计