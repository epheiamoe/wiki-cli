# Web Fetch 配置

让 AI 读取外部文档 URL，是 wiki-cli 工具系统中最特殊的一个——它不访问本地仓库，而是跨越网络边界获取信息。

## 定位：为何需要一个专门的网络工具

在 [工具系统：12 个只读工具](工具系统-12-个只读工具.md) 中，其余 11 个工具都围绕代码仓库操作（读文件、目录遍历、Git 查询）。`fetch_web_markdown` 是唯一一个向外通信的工具，它的使命是：**当 LLM 在生成 Wiki 或回答问题时，发现需要参考某个公共文档 URL（如 README、API 参考），可以自动抓取并转为 Markdown 格式纳入上下文。**

这背后的服务是 **Jina Reader API**（`https://r.jina.ai`），它接受一个 URL，返回干净的 Markdown 文本。用户可配置自己的 API Key 获得更高速率限制，也可以使用免费层（无需 Key）。

[来源](src/ai/tools.ts#L186-L203)

---

## 三个配置项

Web Fetch 的配置字段定义在 `WikiCliConfig` 接口中，存储于 `~/.wiki-cli/config.json`：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `webFetchDisabled` | `boolean` | `false` | 是否禁用 Web Fetch 工具 |
| `webFetchProvider` | `string` | `'jina'` | 提供商名称（当前仅 Jina） |
| `webFetchBaseUrl` | `string` | `'https://r.jina.ai'` | API 基础 URL |
| `webFetchApiKey` | `string` | `undefined` | API 密钥（可选，免费层可留空） |

[来源](src/config/config-store.ts#L19-L27)

`webFetchDisabled` 是总开关。当它为 `true` 时，其余三个字段会被一并清除，避免残留配置误导：

```typescript
// src/commands/config.ts - configureWebFetch 函数
if (!enable) {
  config.webFetchDisabled = true;
  config.webFetchProvider = undefined;
  config.webFetchBaseUrl = undefined;
  config.webFetchApiKey = undefined;
  return;
}
```

[来源](src/commands/config.ts#L196-L202)

---

## 交互式配置流程

`configureWebFetch` 函数（位于 `src/commands/config.ts`）通过四个交互步骤完成配置：

1. **是否启用**——默认值为当前配置的反向（`!config.webFetchDisabled`），保持 UX 直觉
2. **提供商**——输入框模式，默认 `'jina'`
3. **Base URL**——输入框模式，默认 `'https://r.jina.ai'`，支持自定义代理或兼容服务
4. **API Key**——密码模式（输入被掩码遮盖），可选，默认复用已有值或空

这一步在 [配置命令详解](配置命令详解.md) 所述的三套配置体系中，可通过菜单选项 `"Web Fetch (let AI read documentation URLs)"` 单独进入，也可以在初次全量配置（`Both`）时跳过——Web Fetch 默认不会在首次配置中打扰用户。

[来源](src/commands/config.ts#L178-L217)

---

## 运行时：`fetchWebMarkdown` 的执行逻辑

当 AI 调用 `fetch_web_markdown` 工具时，实际执行的是 `fetchWebMarkdown(url)` 函数。它从模块级变量 `webFetchConfig` 中读取运行时配置——这个变量由 `initTools()` 在命令启动时注入。

```typescript
const baseUrl = webFetchConfig?.baseUrl || 'https://r.jina.ai';
const targetUrl = `${baseUrl.replace(/\/+$/, '')}/${url}`;
const apiKey = webFetchConfig?.apiKey;
```

[来源](src/ai/tools.ts#L592-L595)

### 超时机制：AbortController × 15 秒

每个请求都通过 `AbortController` 设置 **15 秒硬超时**，超时后触发 `AbortError`：

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15000);
const res = await fetch(targetUrl, { signal: controller.signal, headers });
clearTimeout(timeout);
```

[来源](src/ai/tools.ts#L599-L603)

如果超时发生，错误信息被捕获为 `'Request timed out after 15s'`，进入重试逻辑。

### 重试策略：指数退避 × 3 次

重试逻辑分三层场景，各有不同的退避间隔：

| 场景 | 退避公式 | 示例延时（第 1/2/3 次） |
|---|---|---|
| **HTTP 429**（Rate Limited） | `2^(attempt+1) × 1000ms` | 2s / 4s / 8s |
| **HTTP 5xx**（服务器错误） | `2^attempt × 1000ms` | 1s / 2s / 4s |
| **网络错误 / 超时** | `2^attempt × 1000ms` | 1s / 2s / 4s |

最大重试次数为 **3**（即最多发送 4 次请求）。所有重试耗尽后，返回统一错误消息：

```typescript
return { type: 'error', data: `Failed after ${maxRetries + 1} attempts: ${lastError}` };
```

[来源](src/ai/tools.ts#L597-L644)

### 请求头部

请求携带三个头部：
- `Accept: text/markdown`——告知 Jina Reader 返回 Markdown 格式
- `User-Agent: wiki-cli/1.0`——标识客户端身份
- `Authorization: Bearer <apiKey>`——仅当配置了 API Key 时才附加

[来源](src/ai/tools.ts#L604-L608)

---

## 工具过滤：`getFilteredTools`

`getFilteredTools()` 是连接配置与工具调度层的桥梁。它在两个地方被调用：

- **generate 命令**——生成大纲时（`src/commands/generate.ts#L351, L391`）
- **ai 命令**——交互式问答时（`src/commands/ai.ts#L117`）

逻辑极简：

```typescript
export function getFilteredTools(): ToolDefinition[] {
  if (webFetchConfig?.disabled) {
    return toolDefinitions.filter(t => t.function.name !== 'fetch_web_markdown');
  }
  return toolDefinitions;
}
```

[来源](src/ai/tools.ts#L477-L482)

当 `webFetchDisabled` 为 `true` 时，`initTools` 被传入 `{ disabled: true, baseUrl: '', apiKey: '' }`，随后 `getFilteredTools()` 从 12 个工具中移除 `fetch_web_markdown`，LLM 将完全无法感知该工具的存在。这避免了 LLM 在无网络配置时产生"工具存在但调用失败"的困惑。

[来源](src/commands/ai.ts#L69-L77)

---

## 配置注入时机

`webConfig` 的组装在两个命令入口处各发生一次：

```typescript
// 不管是 ai 还是 generate，逻辑相同
const webConfig = !config.webFetchDisabled
  ? { baseUrl: config.webFetchBaseUrl || 'https://r.jina.ai', apiKey: config.webFetchApiKey }
  : { disabled: true, baseUrl: '', apiKey: '' };
initTools(undefined, webConfig);
```

[来源](src/commands/ai.ts#L69-L77)

注意 `embeddingConfig` 和 `webConfig` 分别作为 `initTools` 的第一、第二参数传入，完全解耦——Embedding 配置缺失不影响 Web Fetch 运行，反之亦然。

---

## 失败后的保底行为

当所有重试耗尽时，`fetchWebMarkdown` 返回 `{ type: 'error', data: 'Failed after 4 attempts: ...' }`。按照 [工具系统：12 个只读工具](工具系统-12-个只读工具.md) 的错误传播机制，此错误信息会回传给 LLM，由 LLM 自行决定下一步——例如提示用户手动提供文档内容，或跳过该参考源继续生成。

---

## 推荐阅读

- [配置命令详解](配置命令详解.md)——三套配置体系的完整交互流程
- [工具系统：12 个只读工具](工具系统-12-个只读工具.md)——`fetch_web_markdown` 在 12 工具中的上下文
- [LLM 客户端设计与流式通信](llm-客户端设计与流式通信.md)——指数退避策略在 LLM 调用层的复用
- [配置存储架构](配置存储架构.md)——配置文件 JSON 持久化细节