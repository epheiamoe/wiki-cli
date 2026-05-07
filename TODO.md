# TODO

## 近期

- [x] **增量 Wiki 更新（`--update`）**
  - 生成时记录 `.page-deps.json`（每个页面 read_file 的文件+行号范围）
  - `git diff` 行号重叠检测，定位受影响页面
  - Phase 1 Update：LLM 分析变更影响（有 read_wiki 工具）
  - Phase 2 Update：不变页面复制，仅再生受影响页
  - 注入旧版本全文和变更文件列表给 AI

- [ ] **`--update --experimental`（embedding 语义对比）**
  - `git show oldCommit:file | slice [L1,L2]` 取出旧代码段
  - 新旧代码分别做 embedding，计算 cosine similarity
  - 低于阈值才标记重新生成（抗注释/重命名等假阳性）
  - 与当前 --update 共享 Phase 2，仅替换 Phase 1 判定方式

- [ ] **`--update --diff` 预览模式**
  - 列出本次更新将影响的页面（不实际执行）
  - 显示变更文件列表 + 推测的受影响页面 + 每个受影响页面的 tool call 次数

- [ ] **进度网格改进**
  - retry 场景也显示 grid（当前 `retryList` 被排除）
  - progress-grid.ts terminal 宽度无法检测时的 fallback 处理

- [ ] **`read_file` 行号前缀·续**
  - 确认大文件截断场景下 `start_line` 提示的行号计算准确
  - 考虑 `search_in_files` 等工具的 line number 引用一致性

## 中期

- [ ] **`webFetch` 更多 Provider**
  - 支持 Firecrawl、自建 reader 等
  - Provider 插件化

- [ ] **Mermaid 暗色主题同步**
  - browse 页面跟随系统/用户选择的主题切换 mermaid 图表

- [ ] **`.gitignore` 自动管理**
  - 确保克隆远程仓库后首次生成时 `.wiki/temp` 和 `.wiki/sessions/` 自动追加（当前 `ensureGitIgnore` 已做）
  - 考虑 `.gitignore` 冲突合并场景（文件末尾无换行等）

## 远期

- [ ] **CI/CD 集成**
  - GitHub Action 自动触发 Wiki 更新
  - PR 评论预览 Wiki 变更

- [ ] **多语言 Wiki**
  - 同一份源码生成中/英双语 Wiki
  - 页面间自动交叉链接

- [ ] **Wiki 片段引用**
  - AI 问答时直接引用 Wiki 具体段落（带锚点链接）
