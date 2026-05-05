现在我有足够的信息来撰写页面了。

<!-- 浏览 Wiki -->

内置 HTTP 服务器，让你能在浏览器中阅读生成的 Wiki——无需额外工具，一条命令即可启动。

## 一句话启动

```bash
wiki-cli browse
```

这条命令会查找当前目录下的 `.wiki` 目录，找到后启动一个本地服务器并自动打开浏览器。如果当前目录没有 Wiki，也可以用 `-b` 指定路径，或用 `-u` 指定仓库 URL：

```bash
wiki-cli browse -b /path/to/project
wiki-cli browse -u https://github.com/user/repo
```

[来源](src/commands/browse.ts#L39-L61)

---

## 它是如何找到 Wiki 目录的？

`browseCommand` 函数的定位逻辑遵循一条简单规则：**从外到内，找 `.wiki` 文件夹**。

| 传入参数 | 查找方式 |
|---|---|
| 无参数 | 取 `process.cwd()` + `.wiki` |
| `-b path` | 如果 path 直接就是 `.wiki` 目录，用它；如果 path 内嵌了 `.wiki`，进去；否则尝试 path + `.wiki` |
| `-u url` | 先通过 `findExistingRepoDir(url)` 找已克隆的仓库目录，然后拼接 `.wiki` |

如果目录不存在，命令会报错退出，提示你先运行 `wiki-cli generate`。如果存在，它会读取该目录下的所有版本子目录（即时间戳命名的文件夹），按字母逆序排序，取第一个作为最新版本。

[来源](src/commands/browse.ts#L29-L79)

---

## 启动 HTTP 服务器

定位到 Wiki 后，命令调用 `findFreePort(3000)` 找一个可用端口。`findFreePort` 的逻辑很简单：**从端口 3000 开始尝试监听，如果被占用则端口 +1 重试，直到成功**。成功后启动 `createServer`，并在终端打印访问地址。

```typescript
const port = await findFreePort(3000);
```

端口确认后，`server.listen(port)` 启动服务器，同时尝试用系统默认浏览器打开页面（Windows 调用 `start`，macOS 用 `open`，Linux 用 `xdg-open`）。

[来源](src/commands/browse.ts#L135-L153、L994-L1006)

---

## 页面结构：三栏布局

浏览器打开的页面是一个**单页应用**，由 `serveHtml` 函数生成完整的 HTML。整个页面分为三大区域：

### ① 左侧导航栏

固定宽度 280px，深色背景，顶部有版本切换按钮（一个钟表图标），下方是页面列表。每个列表项包含：

- **难度标记**：🟢 初学、🟡 中级、🔴 高级，取自 index.json 中每条 topic 的 `level` 字段
- **页面标题**：可点击，点击后右侧加载对应内容

难度标记的生成逻辑在 `buildSidebarHtml` 函数中：

```typescript
const badge = item.level === '初学' ? '🟢' : item.level === '中级' ? '🟡' : '🔴';
```

如果一个条目是分组标题（`level === 'group'`），则以灰色大写字母显示，不可点击。

[来源](src/commands/browse.ts#L958-L965)

### ② 右侧内容区

占页面剩余宽度（最大 900px），用于渲染 Markdown 内容。点击导航项后，前端通过 `fetch('/api/page/{slug}.md?version=...')` 获取 HTML，然后直接替换内容区的 `innerHTML`。

服务端 `/api/page/` 接口的工作流程：

1. 根据 slug 拼接 `.md` 文件路径
2. 用 `readFile` 读取原始 Markdown
3. 调用 `marked.parse(content)` 将 Markdown 渲染为 HTML
4. 调用 `fixContentReferences` 处理来源引用链接
5. 返回 HTML 给前端

[来源](src/commands/browse.ts#L295-L307)

### ③ 顶部版本切换

页面右上角有一个钟表图标按钮，点击后会弹出版本选择浮层。浮层中列出 `.wiki` 目录下的所有时间戳版本，点击即可切换。

切换时，前端执行 `window.location.href = '/?version=' + ts` 重新加载页面。服务端从 URL 参数中读取 version，然后指向对应版本子目录中的所有文件。

[来源](src/commands/browse.ts#L154-L160、L143-L151)

---

## 源代码查看：行号高亮

每个 Wiki 页面中的 `[来源]` 链接都是一个特殊的超链接，指向 `/api/source/` 路径。当你在 Wiki 内容中看到类似这样的写法：

```
[来源](src/commands/browse.ts#L100-L120)
```

页面中的 `fixContentReferences` 函数会将其转换为：

```html
<a href="/api/source/src/commands/browse.ts#L100-L120" target="_blank" class="source-ref">[来源]</a>
```

点击后，浏览器打开一个源码查看页面，特点包括：

- **行号**：左侧显示行号，等宽字体
- **语法高亮**：使用 highlight.js 根据文件扩展名判断语言（`.ts` → TypeScript、`.js` → JavaScript 等）
- **行高亮**：URL 锚点 `#L100-L120` 会使对应行号添加蓝色背景和左边框，页面加载后自动滚动到该区域
- **安全防护**：`sanitizePath` 函数会阻止路径穿越攻击，确保不会泄露项目根目录外的文件

[来源](src/commands/browse.ts#L309-L402、L428-L432)

---

## Mermaid 图表渲染

页面加载了 `mermaid.min.js`（从 `node_modules/mermaid/dist/` 静态托管），每次加载新页面后自动运行：

```javascript
try { await mermaid.run({ nodes: document.querySelectorAll('.mermaid') }); } catch {}
```

这意味着你可以在 Wiki 的 Markdown 中直接写 Mermaid 图表，生成后页面会自动渲染为漂亮的图表。主题已初始化为 `theme: 'dark'`，与页面整体暗色风格一致。

[来源](src/commands/browse.ts#L797-L811、L1053)

---

## Markdown 代码高亮

服务端使用 `marked-highlight` 插件配合 `highlight.js` 实现代码块的语法高亮。在 `marked.use` 配置中注册：

```typescript
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
}));
```

这意味着 Markdown 中的代码块：
- 如果指定了语言（如 ` ```typescript `），使用对应语言的语法高亮
- 如果未指定语言，自动检测（`highlightAuto`）
- 样式文件 `github-dark.min.css` 从 highlight.js 的 styles 目录静态托管

[来源](src/commands/browse.ts#L24-L33、L701)

---

## AI 聊天面板

如果配置了 LLM，右侧还会出现一个可展开的 AI 聊天面板。点击右上角的机器人图标即可打开。这部分的设计和实现在 [AI 聊天面板：浏览器内对话](ai-聊天面板-浏览器内对话.md) 中有详细介绍。

[来源](src/commands/browse.ts#L805-L815)

---

## 下一步

- 如果你想了解如何生成 Wiki，阅读 [生成 Wiki](生成-wiki.md)
- 配置 LLM 后体验 AI 聊天，详见 [AI 聊天面板：浏览器内对话](ai-聊天面板-浏览器内对话.md)
- 查看你的 Wiki 与当前代码的差异，使用 [查看状态](查看状态.md) 命令