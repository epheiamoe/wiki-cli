# 添加新 LLM 提供商

内置的 7 家提供商可能不够用——你或许想接入自家部署的私有模型，或者某个不在列表中的云服务商。扩展机制只涉及三个步骤：添加模型条目、声明 JSON 模式支持、验证测试。核心代码只有两个文件 `src/config/default-models.json` 和 `src/config/config-store.ts`，改动量通常不超过 20 行。

## 了解底层数据结构

添加之前，先理解系统如何组织模型信息。

### ModelEntry 接口

每个模型在 JSON 数组中对应一个条目，类型定义为 `ModelEntry`：

```typescript
export interface ModelEntry {
  provider: string;      // 提供商名称，同一提供商共享相同字符串
  model: string;         // 模型标识符，如 "gpt-5.5"
  baseUrl: string;       // API 端点基础 URL
  description: string;   // 人可读的描述
  pricingHint?: string;  // 定价提示（可选），仅用于交互式选择时的展示
}
```

[来源](src/config/config-store.ts#L16-L23)

`provider` 字段是分组的依据——`getProviders` 用 `Set` 去重提取所有唯一的提供商名，`getModelsByProvider` 则用 `filter` 按此字段筛选。所以**同一提供商的所有条目必须使用完全一致的 provider 字符串**（大小写敏感）。[来源](src/config/config-store.ts#L67-L73)

### JSON 模式支持的判定逻辑

`supportsJsonMode` 函数决定了生成阶段是否能使用 `response_format: json_object`（详见 [配置存储与高级选项](配置存储与高级选项.md) 中关于 JSON 模式的说明）。其判定逻辑如下：

```typescript
const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
]);

export function supportsJsonMode(provider: string): boolean | undefined {
  if (provider === 'Custom') return undefined; // unknown, ask user
  return JSON_MODE_PROVIDERS.has(provider);
}
```

[来源](src/config/config-store.ts#L27-L38)

三个返回值各代表不同含义：

| 返回值 | 含义 | 行为 |
|---|---|---|
| `true` | 已知支持 JSON 模式 | 自动启用，不询问用户 |
| `false` | 已知不支持 JSON 模式 | 自动禁用，不询问用户 |
| `undefined` | 未知（Custom 模式） | 在 [配置命令](配置命令-wiki-cli-config.md) 的交互提示中询问用户 |

## 三步扩展法

### 第一步：在 default-models.json 添加条目

打开 `src/config/default-models.json`，在数组末尾追加新条目。以添加一个虚构的提供商 **NovaAI** 为例：

```json
{
  "provider": "NovaAI",
  "model": "nova-3-turbo",
  "baseUrl": "https://api.nova-ai.example/v1",
  "description": "NovaAI Turbo 3 (fictional)",
  "pricingHint": "Competitive pricing, fast inference"
}
```

如果需要添加多个模型，只需追加多条记录，保持 `provider` 字符串完全一致：

```json
{
  "provider": "NovaAI",
  "model": "nova-3-lite",
  "baseUrl": "https://api.nova-ai.example/v1",
  "description": "NovaAI Lite 3 (fictional)",
  "pricingHint": "Cheapest NovaAI model"
}
```

**关键约束**：每个条目必须包含 `provider`、`model`、`baseUrl`、`description` 四个必填字段，测试会对所有条目检查这一点。[来源](tests/config-store.test.ts#L30-L38)

### 第二步：更新 JSON 模式支持集合

如果新提供商支持 `response_format: json_object`（即能以 JSON 格式返回结构化输出），则在 `JSON_MODE_PROVIDERS` 集合中添加其名称：

```typescript
const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
  'NovaAI',          // ← 新增
]);
```

如果不确定提供商是否支持 JSON 模式，可以**不添加**。此时 `supportsJsonMode` 将返回 `false`，系统会回退到文本模式生成，通过提示词约束输出格式——这通常也能工作，只是稳定性略低于原生 JSON 模式。

### 第三步：运行测试验证

执行测试套件验证改动是否正确：

```bash
npm test
```

具体来说，`tests/config-store.test.ts` 中的以下测试会验证你的改动：[来源](tests/config-store.test.ts#L1-L70)

1. **结构完整性检查**：每个条目是否包含四个必填字段。
2. **`getProviders` 唯一性**：确保提取的提供商列表无重复。
3. **`getModelsByProvider` 筛选正确性**：确保按提供商筛选后所有条目都属于该提供商。

测试会自动从 `default-models.json` 读取数据并运行上述验证，无需修改测试文件本身。

## Custom 模式的通用兼容性

除了添加固定提供商，系统还内置了 **Custom** 模式（交互式配置中选择 `✏️ Custom (enter manually)`）。[来源](src/commands/config.ts#L52-L66)

Custom 模式的设计哲学是：**任何兼容 OpenAI API 格式的 HTTP 端点都可以接入**。这意味着：
- 你不需要修改任何代码就能使用私有部署的模型（如本地运行的 Ollama、vLLM、Text Generation WebUI 等）
- 只需在交互式配置中手动输入 `baseUrl` 和 `model` 名称
- JSON 模式支持由用户自行确认（`supportsJsonMode('Custom')` 返回 `undefined`，触发询问）

[来源](src/commands/config.ts#L79-L83)

因此，对于快速试验或私有部署场景，Custom 模式比修改源代码更便捷。

## 完整示例：添加 NovaAI

以下是从头到尾添加虚构提供商 **NovaAI** 的完整变更：

**文件改动清单：**

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/config/default-models.json` | 追加 2 条记录 | 添加 nova-3-turbo 和 nova-3-lite |
| `src/config/config-store.ts` | 追加 1 行 | 在 `JSON_MODE_PROVIDERS` 中添加 `'NovaAI'` |

**步骤演练：**

1. 在 `default-models.json` 末尾添加两条 NovaAI 模型条目。
2. 确认 NovaAI API 支持 `response_format: json_object`，因此在 `JSON_MODE_PROVIDERS` Set 中添加 `'NovaAI'`。
3. 运行 `npm test`，观察 `config-store.test.ts` 中所有测试通过：
   - `getProviders` 返回的列表中包含 `'NovaAI'`
   - `getModelsByProvider(models, 'NovaAI')` 返回两条记录
   - 所有条目通过结构校验
4. 运行 `npm run build` 重新编译 TypeScript。
5. 运行 `wiki-cli config`，在提供商列表中即可看到 **NovaAI** 选项，选择后可进一步选择具体模型。

## 下一步

- 完成添加后，参阅 [配置命令](配置命令-wiki-cli-config.md) 了解如何通过交互式或命令行参数配置新提供商。
- 深入了解 JSON 模式的作用与影响，请阅读 [配置存储与高级选项](配置存储与高级选项.md)。
- 了解完整的内置模型列表，参考 [LLM 提供商与模型选择](llm-提供商与模型选择.md)。