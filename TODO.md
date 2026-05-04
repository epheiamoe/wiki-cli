# TODO

## 近期

- [ ] **增量 Wiki 更新（`--update`）**
  - 生成时记录 `.meta.json`（gitCommit + 每个页面关联的 sourceFiles）
  - 增量模式：`git diff` 找出变更文件，只重新生成受影响页面
  - 未变更页面从上一版本复制
  - 大变更（新主题、重构）才触发全量重新生成

- [ ] **opencode skill**
  - 将 `tool-call` 暴露的工具包装为 opencode skill
  - 让 opencode 在问答中能调 `semantic_search`、`read_wiki` 等
  - Skill 文件放在项目根目录 `skills/` 下

## 中期

- [ ] **Git diff 驱动的精准更新**
  - AI 判断变更影响范围：仅改注释 vs 重命名 API vs 新增模块
  - 更新 `.meta.json` 的 sourceFiles 关联

- [ ] **`webFetch` 更多 Provider**
  - 支持 Firecrawl、自建 reader 等
  - Provider 插件化

- [ ] **`generate --update` 交互式确认**
  - 列出受影响的页面，让用户勾选哪些需要更新
  - 支持查看 diff 后再决定

## 远期

- [ ] **CI/CD 集成**
  - GitHub Action 自动触发 Wiki 更新
  - PR 评论预览 Wiki 变更

- [ ] **多语言 Wiki**
  - 同一份源码生成中/英双语 Wiki
  - 页面间自动交叉链接

- [ ] **Wiki 片段引用**
  - AI 问答时直接引用 Wiki 具体段落（带锚点链接）
