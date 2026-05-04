---

# 本地浏览 Wiki

当 `wiki-cli browse` 执行时，`src/commands/browse.ts` 启动了一个基于 Node.js 原生 `http` 模块的本地预览服务器。它不依赖 Express 或 Koa 等第三方框架，整个服务器逻辑全部封装在一个文件、一个 `browseCommand` 异步函数中。这篇文章深入其实现，拆解**端口自动协商、索引加载、Markdown 渲染管道、版本切换和源码浏览**五个核心机制。

[来源](../src/commands/browse.ts)

---

## 启动流程：三步到位

`browseCommand` 的执行路径可概括为三条线性的检查与初始化步骤：

```
browse()
  │
  ├── 1. 检查 .wiki/ 目录是否存在
  │      └── 不存在 → logError + process.exit(1)
  │
  ├── 2. 扫描子目录，按名称排序取最新版本
  │      └── 无子目录 → logError + process.exit(1)
  │
  └── 3. 探测可用端口 → 启动 HTTP 服务器 → 打开浏览器
```

第一步检查项目根目录下是否存在 `.wiki` 文件夹。这是 `generate` 命令的产物，如果缺失，服务器根本无法启动。[快速开始](快速开始.md) 描述了完整的生成流程。[来源](../src/commands/browse.ts#L13-L17)

第二步：以 `{ withFileTypes: true }` 读取 `.wiki` 目录的条目，过滤掉 `temp` 目录，对剩余的时间戳子目录按字符串降序排序。排序靠前的子目录即最新版本。[来源](../src/commands/browse.ts#L19-L26)

第三步是整个命令的重头戏——启动服务器并打开浏览器，下面逐一展开。

---

## 端口自动协商：findFreePort

`findFreePort(3000)` 函数负责找到一个可用的 TCP 端口。它的实现采用了一种**轻量级的试探-递归策略**：

```typescript
async function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(preferred, () => {                   // 尝试监听
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port));          // 成功 → 关闭并返回
      } else {
        srv.close(() => resolve(preferred));
      }
    });
    srv.on('error', () => {                           // 端口被占用
      resolve(findFreePort(preferred + 1));           // 递归尝试下一个端口
    });
  });
}
```

这里的关键设计是**创建一个临时服务器实例**来做端口探测，而非直接在正式服务器上 try-catch。探测成功后立即关闭临时实例，再用确定的端口启动正式服务器。`error` 事件的递归回调保证了端口被占用时自动递增——3000 被占就试 3001，3001 被占就试 3002，以此类推。[来源](../src/commands/browse.ts#L218-L231)

服务器启动后，通过 `execSync` 调用系统命令打开默认浏览器（`start` / `open` / `xdg-open`，分别对应三平台），这是 [跨平台兼容与路径处理](跨平台兼容与路径处理.md) 中的典型模式。[来源](../src/commands/browse.ts#L98-L107)

---

## 索引加载：从 index.json 到侧边栏

服务器启动后，首页渲染函数 `serveHtml` 的第一步是调用 `loadSidebar` 加载侧边栏数据。`loadSidebar` 采用**双格式降级策略**：

| 优先级 | 格式 | 解析函数 | 说明 |
|--------|------|----------|------|
| 第一选择 | `index.json` | `parseIndexJson` | LLM 生成阶段产出的新格式 |
| 第二选择 | `index.md`（嵌入 XML 标签） | `parseIndexXml` | 旧版兼容格式 |
| 第三选择 | 扫描 `.md` 文件 | — | **目前返回空数组**（预留扩展点） |

`parseIndexJson` 的解析流程包含一个重要的健壮性处理：先用 `stripCodeFence` 剥离 LLM 可能包裹的 Markdown 代码围栏（```json ... ```），再用正则 `/\{[\s\S]*\}/` 提取 JSON 对象。这是因为 LLM 在生成阶段输出 JSON 时，有时会附带代码块标记，这个设计消除了对外层格式的依赖。

解析后的数据被归一化为 `SidebarItem[]` 数组，每个条目包含 `title`、`slug`、`level` 三字段。`slug` 由 `slugify` 函数自动生成（全小写、非字母数字字符替换为连字符）。

[侧边栏导航与索引解析](侧边栏导航与索引解析.md) 对两种索引格式的解析细节以及 `buildSidebarHtml` 的前端渲染逻辑做了完整分析。

[来源](../src/commands/browse.ts#L95-L177)

---

## Markdown 渲染管道：/api/page/

`/api/page/` 路由是 Wiki 内容的核心出口。它的处理逻辑是**读取静态 `.md` 文件 → 渲染为 HTML → 替换源码引用**：

```typescript
if (pathname.startsWith('/api/page/')) {
  const slug = decodeURIComponent(pathname.slice(10).replace(/\.md$/, ''));
  const mdPath = join(wikiPath, `${slug}.md`);
  if (existsSync(mdPath)) {
    const content = await readFile(mdPath, 'utf-8');
    const html = await marked.parse(content);
    const fixed = fixContentReferences(html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixed);
  } else {
    res.writeHead(404);
    res.end('Page not found');
  }
}
```

三步流程说明：

1. **路径解析**：截取 `/api/page/` 之后的路径段，`decodeURIComponent` 解码中文和特殊字符，正则 `/\.md$/` 移除可选的 `.md` 后缀。这意味着 `/api/page/本地浏览-wiki` 和 `/api/page/本地浏览-wiki.md` 都能正确命中间一文件。

2. **Markdown → HTML**：使用 `marked` 库（已在 `package.json` 依赖中）执行渲染。`marked` 支持 GFM（GitHub Flavored Markdown），包括表格、任务列表、代码围栏等扩展语法。

3. **源码引用替换**：`fixContentReferences` 函数在 HTML 层面用正则替换 `[来源：路径]` 标记为可点击的链接：

```typescript
function fixContentReferences(html: string): string {
  return html.replace(
    /\[来源：([^\]]+)\]/g,
    '<a href="/api/source/$1" target="_blank" class="source-ref">[来源]</a>'
  );
}
```

替换后的链接指向 `/api/source/` 路由，以新标签页打开原始源码文件。[来源](../src/commands/browse.ts#L45-L57)

---

## 版本切换：?version= 参数

`.wiki` 目录下按时间戳组织的子目录结构，天然支持了多版本浏览能力。`getVersionFromUrl` 函数从请求 URL 中提取 `version` 查询参数：

```typescript
function getVersionFromUrl(reqUrl: string): string {
  try {
    const u = new URL(reqUrl, `http://localhost:${port}`);
    return u.searchParams.get('version') || latest;
  } catch {
    return latest;
  }
}
```

若 `?version=` 参数缺失，默认使用排序后最新的子目录。`/api/page/` 和 `/api/source/` 两个路由在访问文件时，都通过当前 version 参数拼接得到 `wikiPath = join(wikiDir, version)`，从而实现版本隔离。

前端版本切换的入口是页面右上角的「历史版本」按钮。点击后弹出一个浮层（overlay），列出所有可用版本的时间戳：

```typescript
function switchVersion(ts) {
  window.location.href = '/?version=' + ts;
}
```

此函数**整体刷新页面**而非异步加载——因为切换版本后侧边栏结构可能不同（不同版本的索引文件可能不同），不适用 SPA 式局部更新。[来源](../src/commands/browse.ts#L70-L74)

[多版本管理与索引](多版本管理与索引.md) 对时间戳生成和索引结构有更深入的说明。

---

## 源码浏览：/api/source/ 与路径安全

`/api/source/` 路由为 Wiki 中的「来源」链接提供源码展示能力。它的实现涉及两个关键子问题：**路径穿越防御**和**语言检测与高亮**。

### sanitizePath：两层纵深防御

```typescript
function sanitizePath(rawPath: string): string | null {
  const cleaned = rawPath.replace(/^[/\\]+/, '');              // 去掉开头的分隔符
  const normalized = normalize(cleaned)
    .replace(/^(\.\.(\/|\\))+/g, '');                          // 清除 ../ 序列
  const resolved = resolve(PROJECT_ROOT, normalized);           // 与项目根拼接
  if (!resolved.startsWith(PROJECT_ROOT + sep)
      && resolved !== PROJECT_ROOT) {
    return null;                                                // 越界 → 拒绝
  }
  return normalized;
}
```

**第一层**：用 `normalize` 规范化路径（消除 `.` 和多余分隔符），正则清除开头的连续 `../` 序列。这一步拦截最直接的目录穿越攻击。

**第二层**：将清理后的路径与 `PROJECT_ROOT`（`process.cwd()` 的绝对路径）做 `resolve` 拼接，然后用 `startsWith` 确认解析结果仍在项目根目录内。如果攻击者绕过第一层（例如通过符号链接或编码技巧），第二层也能兜底拦截。

校验失败返回 `null`，调用方返回 `403 Forbidden`。[来源](../src/commands/browse.ts#L59-L77)

### 语言检测与 HTML 模板

文件内容读取后，`extToLang` 函数根据扩展名映射 Highlight.js 的 language class：

| 扩展名 | language class |
|--------|---------------|
| `.ts` | `typescript` |
| `.js` | `javascript` |
| `.json` | `json` |
| `.md` | `markdown` |
| `.yml` / `.yaml` | `yaml` |
| `.html` | `html` |
| `.css` | `css` |
| `.sh` / `.bash` | `bash` |
| 其他 | `plaintext` |

返回的页面是一个独立的 HTML 文档，顶部固定导航栏包含「← 返回 Wiki」链接和文件路径，下方为 `<pre><code>` 包裹的源码内容，通过 CDN 加载的 Highlight.js 完成着色。[来源](../src/commands/browse.ts#L67-L75)

---

## 浏览器端 UI 布局

首页渲染函数 `serveHtml` 生成一个完整的单页应用 HTML，其布局结构如下：

```
┌─────────────────────────────────────────────────────┐
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │  📖 Wiki      │  │                              │ │
│  │  [历史版本]    │  │  页面标题（h1）              │ │
│  │──────────────│  │                              │ │
│  │ 🟢 概览       │  │  Markdown 渲染内容...        │ │
│  │ 🟢 快速开始   │  │                              │ │
│  │──────────────│  │  ┌────────────────────────┐  │ │
│  │ 基础概念      │  │  │ 代码块（语法高亮）      │  │ │
│  │ 🟡 项目结构   │  │  └────────────────────────┘  │ │
│  │ 🟡 HTTP 服务器│  │                              │ │
│  │ 🔴 LLM 客户端 │  │  [来源] 链接 → 新标签页      │ │
│  │              │  │                              │ │
│  │              │  │                              │ │
│  └──────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
  侧边栏 280px           内容区（最大宽 900px）
```

**侧边栏特性**：
- 每个条目前带难度徽标（🟢 初学 / 🟡 中级 / 🔴 高级）
- 分组标题（`level: 'group'`）为灰色大写文本，不可点击
- 点击页面条目触发 `loadPage(slug)`，通过 Fetch API 异步加载 `/api/page/`

**内容区特性**：
- 首次加载显示侧边栏第一个页面
- 内部 `.md` 链接被 JavaScript 拦截，执行 SPA 式无刷新切换
- 非 `.md` 的内部链接（如源码引用路径）直接在新标签页打开 `/api/source/`
- 支持 URL hash 直达（如 `/#快速开始`）
- 页面内所有代码块自动调用 `hljs.highlightAll()` 着色

**历史版本浮层**：点击右上角按钮弹出半透明遮罩 + 居中对话框，列出所有时间戳版本，每项点击即切换。[来源](../src/commands/browse.ts#L237-L324)

---

## 路由匹配优先级

服务器内部以 `if-return` 链处理请求，匹配顺序决定了路由优先级：

| 序号 | 匹配条件 | 行为 | 来源 |
|------|----------|------|------|
| 1 | `pathname === '/'` | 渲染首页 HTML | L38-L44 |
| 2 | `/api/page/` 前缀 | 读取 .md → marked → HTML | L45-L57 |
| 3 | `/api/source/` 前缀 | 源码读取 + 语法高亮 | L59-L77 |
| 4 | `.md` 结尾且非 `/api/` | 302 重定向到 `/api/page/` | L79-L84 |
| 5 | 存在于 `wikiPath` 的非 `.md` 文件 | 静态文件服务（按 MIME 类型） | L86-L93 |
| 6 | 以上均不匹配 | 404 Not found | L95-L97 |

**静态文件 MIME 映射**：`.html`、`.css`、`.js`、`.png`、`.jpg`、`.svg` 有精确映射，未知扩展名默认 `application/octet-stream`。[来源](../src/commands/browse.ts#L35-L97)

[HTTP服务器与路由分发](http服务器与路由分发.md) 对路由分发有更聚焦的深入分析。

---

## 关于依赖的选择

服务器只依赖了一个外部库——`marked`（Markdown 渲染）。其他所有能力均基于 Node.js 内置模块：

| 能力 | 依赖来源 |
|------|----------|
| HTTP 服务 | `node:http`（原生） |
| 文件系统 | `node:fs/promises`（原生） |
| 路径处理 | `node:path`（原生） |
| 进程执行 | `node:child_process`（原生） |
| Markdown 渲染 | `marked`（唯一外部依赖） |
| 语法高亮 | CDN 加载 Highlight.js（浏览器端） |

这种设计哲学将服务器端依赖降至最低，让 `browse` 命令即使在离线或受限网络环境下也能正常启动（除了 CDN 加载的 Highlight.js 需要首次加载时有网络）。

---

## 下一步

- 了解索引文件的双格式解析细节：[侧边栏导航与索引解析](侧边栏导航与索引解析.md)
- 查看六条路由的完整匹配逻辑与流程图：[HTTP服务器与路由分发](http服务器与路由分发.md)
- 掌握 `.wiki` 目录的版本化存储结构：[多版本管理与索引](多版本管理与索引.md)
- 了解服务器在整个项目中的模块位置：[项目结构与模块职责](项目结构与模块职责.md)