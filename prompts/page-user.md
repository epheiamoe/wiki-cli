{{updateInstruction}}

为 Wiki 编写一个页面。

<metadata>
- 工作目录：{{workDir}}
- 页面标题：{{pageTitle}}
- 受众水平：{{audienceLevel}}
- 页面标识：{{pageSlug}}
- 简短项目概述：{{projectSummary}}
- 本页编写任务：{{pageTask}}
</metadata>

## 旧版本（如需更新，基于此修改）
{{oldContent}}

## 触发变更的代码（此页面需更新的原因）
{{changeTrigger}}

## 本 Wiki 所有其他页面（交叉引用依据）
{{availablePages}}

要求：
1. 内容深度匹配受众水平（{{audienceLevel}}）。
2. **交叉引用：文中任何地方提及本 Wiki 其他页面的标题或内容时，必须使用 `[页面标题](slug.md)` 格式的可点击链接。** 尤其是「下一步」「推荐阅读」「相关章节」等段落，每条推荐都必须是链接。不允许纯文本提及其他页面。
3. 使用{{lang}}语言，遵循系统提示的风格和格式。
4. 长度适中，不灌水。
5. 每段结尾标注来源，使用 Markdown 链接格式，如 `[来源](src/commands/ai.ts#L10-L20)`。**路径必须从项目根目录开始**，包括完整的目录前缀（如 `src/`、`tests/`、`prompts/`），不能省略。

## 标题修正（仅在必要时使用）
如果当前页面标题（{{pageTitle}}）与内容不符（如过时的数字、版本号），
在输出的**最末尾**单独加一行：
TITLE: <正确标题>
系统会自动更新标题、URL 标识，并修复其他页面的交叉引用。
`TITLE:` 之前不能有任何文字（也不能有前导空格）。**非必要不使用**。
示例：
TITLE: 33 个 AI 工具系统
