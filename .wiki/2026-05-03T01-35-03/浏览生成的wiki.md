现在来写这个页面。

---

# 浏览生成的 Wiki

生成完 Wiki 后，你肯定想立刻看看效果。`browse` 命令让你在本地浏览器中预览整个 Wiki 文档站——无需部署，一行命令即可。

```bash
wiki-cli browse
```

执行后，控制台会输出类似 `Wiki server started at http://localhost:3000` 的消息，并自动弹出浏览器窗口。下面我们拆开看看它具体做了什么。

---

## 自动定位最新的 Wiki 目录

`browse` 的第一步，是在项目根目录下的 `.wiki` 文件夹里，找到最新生成的那份 Wiki。为什么会有"多份"？因为每次运行 `wiki-cli generate` 都会创建一个带时间戳的子目录（例如 `20250315_143022`），以备历史版本回溯。

代码逻辑非常直接：扫描 `.wiki` 下的所有子目录，按名称排序后取第一个（最新的）。[来源](../src/commands/browse.ts#L19-L31)

```typescript
const entries = await readdir(wikiDir, { withFileTypes: true });
const timestamps = entries
  .filter(e => e.isDirectory() && e.name !== 'temp')
  .map(e => e.name)
  .sort()
  .reverse();
const latest = timestamps[0];
```

如果没有找到任何生成的 Wiki，命令会报错提示你先运行 `wiki-cli generate`。[快速开始](快速开始.md) 里有完整的生成流程。

---

## 启动 HTTP 服务器并打开浏览器

找到目录后，`browse` 会做两件事：

1. **找一个可用端口**——默认从 3000 开始尝试，如果被占用就自动递增（`findFreePort` 函数）。[来源](../src/commands/browse.ts#L218-L231)
2. **启动一个基于 Node.js 原生 `http` 模块的服务器**——这个服务器不依赖 Express 等第三方框架，轻量且零外部依赖。[来源](../src/commands/browse.ts#L33-L34)

服务器启动后，命令会尝试**自动打开浏览器**：

```typescript
const start =
  process.platform === 'win32' ? 'start' :
  process.platform === 'darwin' ? 'open' : 'xdg-open';
execSync(`${start} ${url}`, { stdio: 'ignore' });
```

三个平台各用各自的命令：Windows 用 `start`，macOS 用 `open`，Linux 用 `xdg-open`。如果自动打开失败（比如在无图形界面的服务器上），控制台会提示你手动访问链接。[跨平台兼容与路径处理](跨平台兼容与路径处理.md) 有更详细的说明。[来源](../src/commands/browse.ts#L101-L108)

---

## 页面布局：深色侧边栏 + 内容区

打开的页面采用经典的双栏布局，整体配色基于 GitHub Dark 主题。

**左侧侧边栏（280px 宽）**：以导航树的形式列出所有文档页面。每个条目前面都有一个**难度徽章**：

| 徽章 | 对应难度 |
|------|----------|
| 🟢 | 初学 |
| 🟡 | 中级 |
| 🔴 | 高级 |

这个难度信息来自生成阶段 LLM 为每个页面打上的标签。侧边栏的序号由 `buildSidebarHtml` 函数根据索引文件（`index.json` 或 `index.md`）渲染。[侧边栏导航与索引解析](侧边栏导航与索引解析.md) 深入介绍了索引文件的两种格式。[来源](../src/commands/browse.ts#L209-L217)

**右侧内容区**：展示选中的 Wiki 页面。核心特性包括：

- **Markdown 渲染**——使用 `marked` 库将 `.md` 文件转为 HTML。[来源](../src/commands/browse.ts#L53-L54)
- **代码语法高亮**——页面加载时自动调用 `highlight.js` 对所有代码块着色。[来源](../src/commands/browse.ts#L261-L262)
- **点击内部链接**——点击另一篇 Wiki 页面的链接，无需刷新整个页面，通过 `fetch` 异步加载内容并替换右侧区域。[来源](../src/commands/browse.ts#L254-L259)

---

## 源码引用功能

这是本 Wiki 最有特色的功能之一。你可能注意到了，每个页面的段落末尾都有类似 `[来源](../src/commands/browse.ts#L19-L31)` 的链接。

当鼠标悬停或点击这些链接时，**浏览器会打开一个新标签页**，展示原始源代码文件，并带有语法高亮。这个功能的实现分为两步：

1. **生成阶段**——LLM 在写 Wiki 内容时，会标注来源文件路径和行号，格式为 `[来源：path/to/file]`。
2. **浏览阶段**——服务器在渲染页面时，通过 `fixContentReferences` 函数，把 `[来源：...]` 替换成指向 `/api/source/...` 的可点击链接。[来源](../src/commands/browse.ts#L187-L190)

当用户点击链接时，服务器收到 `/api/source/` 开头的请求，会：

- 从路径中提取文件路径，经过 `sanitizePath` 校验防止目录穿越攻击（防止用户读取项目外的文件）。[来源](../src/commands/browse.ts#L155-L162)
- 读取源文件内容，根据文件扩展名选择对应的语言进行语法高亮。[来源](../src/commands/browse.ts#L166-L179)
- 返回带 `highlight.js` 类名的 `<pre><code>` 块。[来源](../src/commands/browse.ts#L67-L75)

> **安全注意**：`sanitizePath` 函数会阻止访问项目根目录之外的文件，这是出于安全考虑。[HTTP服务器与路由分发](HTTP服务器与路由分发.md) 中详细介绍了服务器全部的路由规则。

---

## 服务器路由速览

`browse` 启动的服务器虽小，但五脏俱全。所有路由都定义在 `createServer` 的回调里：

| 路由 | 作用 |
|------|------|
| `/` | 渲染主页面（侧边栏 + 首页内容） |
| `/api/page/:slug` | 异步加载某个 Wiki 页面的 HTML |
| `/api/source/:path` | 返回源代码文件（语法高亮） |
| `/*.md` | 重定向到 `/api/page/` 路由 |
| 其他静态文件 | 直接返回（如图片、CSS） |

想了解完整的路由匹配逻辑，参见 [HTTP服务器与路由分发](HTTP服务器与路由分发.md)。[来源](../src/commands/browse.ts#L35-L87)

---

## 下一步

- 想看 `browse` 命令有哪些可选参数？[命令行参考手册](命令行参考手册.md)
- 想了解索引文件的结构以便自定义侧边栏？[侧边栏导航与索引解析](侧边栏导航与索引解析.md)
- 还没生成 Wiki？从 [快速开始](快速开始.md) 入手