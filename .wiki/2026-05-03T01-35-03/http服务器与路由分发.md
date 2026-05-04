# HTTP服务器与路由分发

基于 Node.js 原生 `http` 模块构建的本地 Wiki 预览服务器——这是 `wiki-cli` 的浏览子系统核心。服务器负责将 `.wiki` 目录下已生成的 Markdown 页面渲染为带侧边栏导航的交互式 HTML，并通过 6 条明确定义的路由分别处理首页、页面内容、源码引用、重定向、静态资源和错误兜底。

> **前置阅读**：如果你尚未了解 `browse` 命令的完整工作流，建议先阅读 [浏览生成的Wiki](浏览生成的wiki.md)。本文聚焦于 `createServer` 回调函数内部的实现细节。

---

## 服务器启动与端口探测

服务器启动的第一步是获取一个可用端口。`browseCommand` 函数调用 `findFreePort(3000)`，尝试以 3000 为起始端口建立服务。

`findFreePort` 的实现非常简洁，利用了 `http.createServer` 的 `listening` 和 `error` 事件来完成端口协商：

```typescript
async function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(preferred, () => {           // 尝试监听首选端口
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port)); // 成功则关闭并返回实际端口
      } else {
        srv.close(() => resolve(preferred));
      }
    });
    srv.on('error', () => {                  // 端口被占用则递归尝试 +1
      resolve(findFreePort(preferred + 1));
    });
  });
}
```

**核心逻辑**：创建一个临时服务器实例尝试 `listen(preferred)`。若成功，立即关闭并返回该端口；若失败（端口被占用），通过 `error` 事件捕获，递归调用自身并将端口号加 1 继续尝试。这是一种**轻量级的端口探测策略**，不需要引入第三方端口扫描库。端口确定后，正式服务器会在该端口上启动，并自动调用系统默认浏览器打开 `http://localhost:{port}`（跨平台兼容逻辑见 [跨平台兼容与路径处理](跨平台兼容与路径处理.md)）。

[来源](src/commands/browse.ts#L173-L186)

---

## 六条路由的请求分发

服务器创建在 `createServer` 回调节内部，通过解析 `req.url` 的路径名（`pathname`），以 `if-return` 链的形式逐一匹配 6 条路由。路由表的匹配顺序至关重要：**特例优先，泛化在后**。

### 1. `/` — 首页

首页路由是站点的入口。`serveHtml` 函数执行以下操作：

1. 读取侧边栏的第一个页面的 Markdown 内容
2. 调用 `marked.parse()` 将 Markdown 渲染为 HTML
3. 通过 `fixContentReferences()` 将源码引用文本替换为可点击链接
4. 将侧边栏 HTML 与页面内容嵌入一个完整的 HTML 模板中返回

生成的 HTML 页面包含左侧导航栏和右侧内容区，同时内嵌了前端 JavaScript——负责监听侧边栏的点击事件并异步加载 `/api/page/:slug` 的内容。侧边栏的构建逻辑由 `loadSidebar` 函数承载，它先尝试读取 `index.json`（新格式），失败则回退到 `index.md`（XML 格式），具体解析方法见 [侧边栏导航与索引解析](侧边栏导航与索引解析.md)。

[来源](src/commands/browse.ts#L191-L238)

### 2. `/api/page/:slug` — 页面内容渲染

此路由负责按 **slug**（页面标识符）返回单个 Wiki 页面的 HTML。流程如下：

```
路径截取：pathname.slice(10)  →  去掉 "/api/page/" 前缀
slug 提取：decodeURIComponent()  并去除 .md 后缀
文件查找：join(wikiPath, `${slug}.md`)
渲染输出：marked.parse(content)  →  fixContentReferences(html)
```

**关键细节**：`decodeURIComponent` 确保了中文字符和特殊字符的路径能正确解码。请求参数中的 `.md` 扩展名会被自动剥离再拼接，这意味着 `/api/page/HTTP服务器与路由分发.md` 和 `/api/page/HTTP服务器与路由分发` 都能正确命中同一文件。若文件不存在，返回 `404 Page not found`。

[来源](src/commands/browse.ts#L45-L57)

### 3. `/api/source/:path` — 源码引用查看

这是 Wiki 页面中「[来源]」链接的目标路由，承担着**源码展示**的职能。处理流程：

1. 截取路径（`pathname.slice(12)` 去掉 `/api/source/` 前缀）
2. 执行 `sanitizePath()` 做路径穿越防护（详见下文）
3. 文件存在则读取其内容，按扩展名映射语法高亮的 language class
4. 包裹在 `<pre><code class="language-xxx">` 标签中返回

**安全是此路由的第一优先级**，因为用户生成的 Wiki 页面中可能包含指向项目根目录之外的文件引用。

[来源](src/commands/browse.ts#L59-L77)

### 4. `.md 重定向` — 兼容旧链接

以 `.md` 结尾但不在 `/api/` 前缀下的路径，统一执行 **302 临时重定向**到对应的 API 页面路由：

```
/api/page/encodeURIComponent(slug).md
```

例如，`/HTTP服务器与路由分发.md` → `302 → /api/page/HTTP服务器与路由分发.md`。这一设计的目的是：如果用户直接从文件系统打开 `.md` 文件、或通过外部链接访问原始文件名，服务器能优雅地将其导向渲染后的 HTML 页面。

[来源](src/commands/browse.ts#L79-L84)

### 5. 静态文件服务

对于路径不以 `.md` 结尾且存在于 `wikiPath` 下的资源文件，按 MIME 类型映射表提供静态服务。支持的 MIME 类型包括：

| 扩展名 | MIME 类型 |
|---------|-----------|
| `.html` | `text/html; charset=utf-8` |
| `.css`  | `text/css` |
| `.js`   | `application/javascript` |
| `.md`   | `text/markdown; charset=utf-8` |
| `.png`  | `image/png` |
| `.jpg`  | `image/jpeg` |
| `.svg`  | `image/svg+xml` |

未知扩展名默认以 `application/octet-stream` 处理。注意 `.md` 文件虽在 MIME 表中有条目，但会被**第 4 条路由**（`.md` 重定向）优先拦截，所以实际不会落到此路由。[来源](src/commands/browse.ts#L86-L93)

### 6. 404 兜底

当前 5 条路由均未匹配时，返回纯文本 `Not found`，状态码 404。[来源](src/commands/browse.ts#L95-L97)

---

## 路由匹配流程图

```
请求进入
  │
  ├─ pathname === '/'                     ──→ serveHtml()           [路由1]
  │
  ├─ pathname.startsWith('/api/page/')    ──→ 读取 .md → marked →   [路由2]
  │                                          fixContentReferences
  │
  ├─ pathname.startsWith('/api/source/')  ──→ sanitizePath →        [路由3]
  │                                          读取源码 → 语法高亮
  │
  ├─ pathname.endsWith('.md')             ──→ 302 → /api/page/...   [路由4]
  │   && !pathname.startsWith('/api/')
  │
  ├─ 文件存在于 wikiPath 且非 .md         ──→ 静态文件服务           [路由5]
  │
  └─ 以上均不匹配                        ──→ 404                   [路由6]
```

---

## sanitizePath：路径穿越防护

`/api/source/:path` 路由最危险的使用场景是 **路径穿越攻击（Path Traversal）**——用户构造诸如 `../../etc/passwd` 的路径来读取项目根目录之外的敏感文件。

`sanitizePath` 函数采用两层防护策略：

```typescript
function sanitizePath(rawPath: string): string | null {
  // 第一层：规范化路径，并清除开头的 ../ 序列
  const normalized = normalize(rawPath).replace(/^(\.\.(\/|\\))+/g, '');
  // 第二层：解析为绝对路径后校验前缀
  const resolved = resolve(PROJECT_ROOT, normalized);
  if (!resolved.startsWith(PROJECT_ROOT + sep) && resolved !== PROJECT_ROOT) {
    return null;  // 越界，拒绝请求
  }
  return normalized;
}
```

**第一层 — 清理 `../` 前缀**：`normalize` 将路径规范化（消除 `./` 和多余的分隔符），正则 `/^(\.\.(\/|\\))+/g` 移除开头的连续 `../` 序列。这一步防止攻击者直接用 `../../../` 跳出目录。

**第二层 — 边界校验**：将清理后的路径与 `PROJECT_ROOT`（即 `process.cwd()` 的绝对路径）进行 `resolve` 拼接，然后用 `startsWith` 检查解析后的绝对路径是否以 `PROJECT_ROOT` 开头。这里考虑了两种边界情况：路径本身等于 `PROJECT_ROOT` 或恰好在根目录内。校验失败返回 `null`，调用方会收到 `403 Forbidden`。

> **为什么需要两层？** 第一层消除显式的目录跳转，第二层兜底防御更隐蔽的路径构造（例如利用符号链接或编码绕过）。两者配合形成纵深防御。跨平台细节见 [跨平台兼容与路径处理](跨平台兼容与路径处理.md)。

[来源](src/commands/browse.ts#L116-L122)

---

## fixContentReferences：从文本标记到可点击链接

在 Wiki 生成的页面中，工具自动在代码引用旁插入了 `[来源：xxx]` 标记，其中 `xxx` 是文件相对路径（如 `src/utils/file.ts`）。`fixContentReferences` 函数将这些纯文本标记替换为 HTML 超链接：

```typescript
function fixContentReferences(html: string): string {
  return html.replace(
    /\[来源：([^\]]+)\]/g,
    '<a href="/api/source/$1" target="_blank" class="source-ref">[来源]</a>'
  );
}
```

**替换效果**：`[来源：src/utils/file.ts]` → `<a href="/api/source/src/utils/file.ts" target="_blank" class="source-ref">[来源]</a>`

正则表达式 `\[来源：([^\]]+)\]` 匹配格式为 `[来源：任意非]字符]` 的文本，`$1` 捕获组提取路径部分，将其嵌入到指向 `/api/source/` 的链接中。链接使用 `target="_blank"` 新建标签页打开，并带有 `source-ref` CSS 类名供前端样式定制。此函数在以下两个场景被调用：

- 首页渲染时（`serveHtml` 中处理 firstPage 和各页面的内容）
- `/api/page/:slug` 输出 HTML 前（`marked.parse` 之后）

这意味着即使用户直接访问单个页面 API，引用链接也会被正确替换。

[来源](src/commands/browse.ts#L133-L138)

---

## 侧边栏加载：双格式兼容

`loadSidebar` 函数支持两种索引格式的解析，前者由 Wiki 生成流程自动产出，后者为旧版兼容：

1. **`index.json`（新格式）**：由 `parseIndexJson` 解析，从 JSON 中提取 `sections[].topics[].title` 作为侧边栏项
2. **`index.md`（XML 格式，旧版）**：由 `parseIndexXml` 解析，从 Markdown 中的 `<topic level="...">标题</topic>` 标签提取

两种格式最终都被归一化为 `SidebarItem[]` 数组，包含 `title`、`slug`、`level` 三个字段。`slug` 通过 `slugify` 函数由标题生成（全小写、特殊字符替换为连字符）。侧边栏的 HTML 渲染逻辑见 [侧边栏导航与索引解析](侧边栏导航与索引解析.md)。

[来源](src/commands/browse.ts#L138-L168)

---

## 关键设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| HTTP 框架 | 原生 `http` 模块 | 零依赖，避免 Express/Koa 等重型框架的引入 |
| Markdown 渲染 | `marked` | 体积小、速度快、支持 GFM，已在 `package.json` 依赖中 |
| 源码引用链接 | 文本替换而非 AST 分析 | 在 HTML 层面做正则替换，对渲染管道无侵入 |
| 端口探测 | 递归重试 +1 | 简单可靠，无外部依赖，适合本地预览场景 |
| 路径校验 | `normalize` + `resolve` 双重防御 | 兼顾路径清理与边界检查，防御路径穿越 |

---

## 下一步

- 深入了解侧边栏索引的两种格式与解析细节，参见 [侧边栏导航与索引解析](侧边栏导航与索引解析.md)
- 了解 Wiki 的生成流程如何产出这些页面与索引文件，参见 [页面生成：逐页输出与并行加速](页面生成：逐页输出与并行加速.md)
- 掌握跨平台路径处理的安全最佳实践，参见 [跨平台兼容与路径处理](跨平台兼容与路径处理.md)