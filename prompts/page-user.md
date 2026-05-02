为 Wiki 编写一个页面。

<metadata>
- 工作目录：{{workDir}}
- 页面标题：{{pageTitle}}
- 受众水平：{{audienceLevel}}
- 页面标识：{{pageSlug}}
- 简短项目概述：{{projectSummary}}
- 本页生成指引：{{pageBrief}}
</metadata>

## 本 Wiki 所有页面列表（用于交叉引用）
{{availableSlugs}}

要求：
1. 根据本页在目录中的定位，内容深度匹配受众水平。
2. 交叉引用时从上方页面列表中选择正确的 slug，格式：`[页面标题](slug.md)`
3. 使用{{lang}}语言，遵循系统提示的风格和格式。
4. 长度适中，不灌水。
5. 每段结尾标注来源，使用 Markdown 链接格式，如 `[来源](path#Lx-Ly)`。
