# 内置 HTTP 服务器架构

`browse` 命令的核心是一个基于 Node.js 原生 `http.createServer` 构建的轻量级 HTTP 服务器。它不依赖 Express 或 Koa 等框架，所有路由分发、模板渲染、MIME 类型处理均在单个回调函数中完成。这种设计带来了零外部依赖的好处——整个服务器只依赖 `marked`（Markdown 转 HTML）和 `highlight.js`（代码高亮）两个渲染库。

## 架构概览

服务器的生命周期分为三个阶段：**目录解析** → **端口发现** → **请求监听**。

```
┌─────────────────────────────────────────────────────────┐
│  browseCommand(options?)                                 │
│                                                         │
│  1. 解析 .wiki 目录路径 ──→ 扫描版本子目录 ──→ 排序取最新 │
│  2. findFreePort(3000) ──→ 获取可用端口                  │
│  3. createServer(handler) ──→ listen(port) ──→ 打开浏览器│
└─────────────────────────────────────────────────────────┘
```

`browseCommand` 首先解析 `.wiki` 目录位置：支持 `--path` 参数指定、`--url` 参数从远程仓库定位、或默认当前工作目录。找到目录后，扫描其下所有子目录（排除 `temp` 和 `sessions`），按名称字典序降序排列——由于版本目录使用时间戳命名（如 `2024-01-15T10-30-00-000Z`），降序即最新的版本排在最前。[来源](src/commands/browse.ts#L24-L44)

## 路由表

服务器使用 `URL` 构造函数解析请求路径，然后依次匹配 5 条路由规则：

| 优先级 | 路径模式 | 行为 | 响应类型 |
|--------|----------|------|----------|
| 1 | `/` | 加载侧栏数据，渲染完整 HTML 页面（含暗色主题 CSS、Mermaid、highlight.js） | `text/html` |
| 2 | `/api/versions` | 返回所有版本时间戳数组，标记当前版本 | `application/json` |
| 3 | `/api/page/{slug}` | 读取对应 `.md` 文件，`marked.parse` 转 HTML，替换 `[来源]` 引用为链接 | `text/html` |
| 4 | `/api/source/{path}` | 路径安全校验后读取源码文件，highlight.js 逐行高亮，拼装独立 HTML 页面 | `text/html` |
| 5 | `*.md`（非 `/api/`） | 302 重定向到 `/api/page/{slug}.md?version={v}` | — |
| fallback | 静态文件 | 根据扩展名匹配 MIME 类型返回文件内容 | 按类型 |
| 404 | 未匹配 | 返回 `Not found` | `text/plain` |

路由检查通过 `if-return` 链实现，每个分支命中后直接 `return` 终止处理。未匹配任何规则时，尝试将 `pathname` 作为 `.wiki` 版本目录下的静态文件返回；如果文件不存在或路径以 `.md` 结尾（已由规则 5 转发），则返回 404。[来源](src/commands/browse.ts#L89-L175)

## 端口发现机制

`findFreePort` 使用递归 + 事件监听实现端口扫描，而非依赖外部端口检测工具：

```typescript
async function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(preferred, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => resolve(preferred));
      }
    });
    srv.on('error', () => resolve(findFreePort(preferred + 1)));
  });
}
```

核心逻辑：尝试在 `preferred` 端口（默认为 3000）上创建一个临时服务器。如果 `listen` 成功（即端口可用），立即关闭服务器并返回该端口号。如果 `listen` 触发 `error` 事件（端口被占用），递归调用自身，`preferred + 1` 继续尝试。这种设计保证：
- 即使端口 3000 被占用，也会自动递增直到找到可用端口
- 服务器创建与端口检测复用同一个 `createServer`，不依赖外部命令
- 异步递归在可用端口稀疏时仍能高效收敛

`listen` 成功后通过 `server.address()` 获取实际端口——这处理了 `preferred: 0`（系统分配端口）的场景，尽管当前入口固定传入 3000。[来源](src/commands/browse.ts#L249-L260)

## MIME 类型映射

静态文件服务依赖一个精简的 MIME 映射表：

```typescript
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};
```

未匹配的扩展名统一返回 `application/octet-stream`。注意 `.md` 文件虽然在此映射表中，但实际上路由规则 5 会将所有非 `/api/` 路径的 `.md` 请求 302 重定向到 `/api/page/` 端点，因此静态文件分支不会直接返回原始 Markdown 文件。[来源](src/commands/browse.ts#L57-L65)

## HTML 模板体系

服务器构建两类 HTML 页面，均内联完整样式与脚本，不依赖本地静态资源文件。

### 主页面：`serveHtml`

这是整个 Wiki 浏览器的核心界面，`serveHtml` 函数接收侧栏数据、所有版本列表、当前版本号等参数，拼装出完整 HTML。模板结构如下：

```
┌────────────────────────────────────────────┐
│ <head>                                      │
│   highlight.js 主题 (CDN)                   │
│   暗色主题全局样式 (内联)                     │
│ </head>                                     │
│ <body>                                      │
│   <div.wrapper>                             │
│     <div.sidebar>                           │
│       <h2>📖 Wiki</h2>                      │
│       <button>历史版本</button>              │
│       <ul> 侧栏导航列表 </ul>                │
│     </div>                                  │
│     <div.content> 首屏 Markdown 渲染内容 </div>│
│   </div>                                    │
│   <div.overlay> 版本切换浮层 </div>          │
│   <script>                                  │
│     highlight.js 初始化                      │
│     mermaid 初始化 (dark 主题)               │
│     loadPage(slug) 异步加载页面              │
│     switchVersion(ts) 版本切换               │
│     哈希路由：location.hash → loadPage      │
│   </script>                                 │
│ </body>                                     │
└────────────────────────────────────────────┘
```

关键设计要点：

- **暗色主题 CSS** — 背景 `#0d1117`（GitHub Dark 风格），文本 `#c9d1d9`，侧栏 `#161b22`，边框 `#30363d`。所有颜色值与 GitHub 暗色模式一致，确保代码块和 Mermaid 图表的视觉融合。[来源](src/commands/browse.ts#L293-L331)

- **Mermaid 集成** — 从 CDN 加载 `mermaid@11`，初始化时设置 `theme: 'dark'`。每次 `loadPage` 成功渲染 Markdown 后，调用 `mermaid.run()` 扫描 `.mermaid` 类元素进行渲染。[来源](src/commands/browse.ts#L396-L397)

- **highlight.js 集成** — 加载 `highlight.js@11.9.0` 及 `github-dark` 主题 CSS。页面加载和每次 `loadPage` 后调用 `hljs.highlightAll()` 为代码块着色。[来源](src/commands/browse.ts#L394-L395)

- **侧栏导航** — 从 `index.json` 或 `index.md` 解析出的侧栏数据，通过 `buildSidebarHtml` 生成带难度标记的导航列表：🟢 初学、🟡 中级、🔴 高级。每个条目点击时触发 `loadPage(slug)`。[来源](src/commands/browse.ts#L236-L244)

- **版本切换 overlay** — 点击"历史版本"按钮弹出浮层，列出所有版本时间戳。当前版本高亮标记，点击其他版本触发 `switchVersion(ts)`，URL 刷新并加载对应版本的 Wiki。[来源](src/commands/browse.ts#L398-L415)

- **哈希路由** — 页面加载时检查 `location.hash`，若有值则解码后调用 `loadPage` 加载对应页面。这使得用户可以直接通过 URL 片段（如 `#项目架构全景`）定位到特定页面。[来源](src/commands/browse.ts#L418-L421)

### 源码页面：`/api/source/{path}`

区别于主页面，源码页面是一个独立的完整 HTML 文档，专为代码阅读优化。其渲染逻辑在路由规则 4 中内联实现，详细架构参见 [源码浏览与行号高亮](本地-http-服务器与前端.md)。[来源](src/commands/browse.ts#L128-L170)

## API 端点详解

### `/api/versions`

返回 JSON 数组，每个元素包含时间戳和当前标记：

```json
[
  { "ts": "2024-01-15T10-30-00-000Z", "current": true },
  { "ts": "2024-01-14T08-20-00-000Z", "current": false }
]
```

版本列表来自 `browseCommand` 启动时扫描 `.wiki` 目录的结果，按字典序降序排列（最新在前）。`current` 字段由请求 URL 中的 `?version=` 参数或默认最新版本决定。[来源](src/commands/browse.ts#L99-L106)

### `/api/page/{slug}`

接收页面 slug（如 `项目架构全景`），在对应版本的 `.wiki/{version}/{slug}.md` 中查找 Markdown 文件。找到后：
1. 使用 `marked.parse` 将 Markdown 转为 HTML
2. 调用 `fixContentReferences`，将 `[来源：src/xxx.ts#L10-L20]` 格式的文本转换为指向 `/api/source/` 的可点击链接
3. 返回纯 HTML 片段（不含 `<body>` 等外层结构），由前端 `loadPage` 注入到主页面内容区域

注意 slug 允许带或不带 `.md` 后缀，服务器会统一去除。404 时返回纯文本 `Page not found`。[来源](src/commands/browse.ts#L108-L121)

### `/api/source/{path}`

提供源码浏览与行号高亮功能。路径经过 `sanitizePath` 安全校验——该函数通过 `normalize` + `resolve` 检查路径是否逃逸出项目根目录，防止目录遍历攻击。校验通过后：

1. 读取文件内容，按行分割
2. 根据扩展名映射语言（通过 `extToLang`，支持 `.ts`→`typescript`、`.js`→`javascript` 等 9 种映射）
3. 逐行调用 `hljs.highlight` 生成语法高亮 HTML
4. 拼装包含行号、sticky 头部、语言标签的完整源码页面
5. 支持 URL hash 定位（`#L10` 或 `#L10-L20`），页面加载后自动高亮对应行并滚动到可视区域

[来源](src/commands/browse.ts#L123-L170)

## 启动与自动打开

服务器启动后，`server.listen` 回调中通过 `execSync` 调用系统命令自动打开浏览器：Windows 使用 `start`，macOS 使用 `open`，Linux 使用 `xdg-open`。若自动打开失败（如无 GUI 环境），仅打印 URL 提示用户手动访问。[来源](src/commands/browse.ts#L177-L189)

---

## 推荐阅读

- [浏览命令：wiki-cli browse](浏览命令-wiki-cli-browse.md) — `browse` 命令的完整命令行接口与参数说明
- [源码浏览与行号高亮](本地-http-服务器与前端.md) — `/api/source` 端点的路径安全校验与逐行高亮实现
- [侧栏导航与版本管理](本地-http-服务器与前端.md) — `index.json` 解析与侧栏树构建
- [项目架构全景](cli-入口与命令调度机制.md) — 从 CLI 入口到各命令模块的调度链路