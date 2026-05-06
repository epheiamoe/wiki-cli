现在我已经掌握了所有必要信息，可以开始撰写页面了。

---

# Git 差异分析与依赖追踪

## 问题：全量生成太重了

对于一个已有 Wiki 的仓库，每次仅改动几行代码就触发所有页面的重新生成，既不经济也浪费时间。[增量更新（--update）模式](增量更新-update-模式.md) 通过精确定位受影响的页面来解决这个问题。但实现精准更新的前提是回答两个问题：

1. **代码哪里变了？** —— Git 差异分析
2. **哪些页面依赖于这些变更？** —— 依赖追踪

`src/utils/diff.ts` 回答了第一个问题，`src/commands/generate.ts` 中的全局变量机制回答了第二个问题。

---

## 一、变更文件列表：`getChangedFiles`

`getChangedFiles(oldCommit, cwd)` 执行一条 `git diff` 命令获取从指定提交到 HEAD 之间的文件变更：

```ts
git diff ${oldCommit}..HEAD --name-status --diff-filter=ADMR
```

- `--name-status`：只输出文件名和状态前缀（`A`/`D`/`M`/`R`），不输出内容差异。
- `--diff-filter=ADMR`：只保留 **A**dded（新增）、**D**eleted（删除）、**M**odified（修改）、**R**enamed（重命名）四种状态，排除其他操作（如复制、类型变更）。

### 解析流程

`parseGitDiff` 将原始输出按行拆解，每行首字符映射为 `ChangedFile.status`：

| Git 前缀 | 映射状态 |
|----------|----------|
| `A\t`    | `added`  |
| `D\t`    | `deleted` |
| `R`      | `renamed` |
| 其他     | `modified`（默认） |

路径部分通过 `line.replace(/^[A-Z]+\t/, '')` 剥离前缀后获得。返回的 `ChangedFile[]` 将作为后续所有分析的数据源。

[来源](src/utils/diff.ts#L1-L41)

---

## 二、行级变更范围：`getChangedRanges`

知道哪些文件变了还不够——一个 1000 行的文件可能只改了 3 行。`getChangedRanges` 针对单个文件，通过 `git diff ${oldCommit}..HEAD -- "${filePath}"` 获取完整差异内容，然后从差异中提取变更发生在哪些行区间。

### Hunk Header 解析

Git 的 diff 输出以 **hunk**（块）为单位组织，每个 hunk 的头部格式为：

```
@@ -a,b +c,d @@
```

其中 `+c,d` 表示变更后的文件中，从第 `c` 行开始、连续 `d` 行是变更区域（新增/修改/删除）。`parseHunks` 使用正则 `^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@` 提取 `c` 和 `d`，然后生成闭区间 `[start, start + count - 1]`。

```
@@ -10,6 +12,8 @@
```

这一行表示新文件从第 12 行开始、共 8 行是变更区域，对应行区间 `[12, 19]`。

如果 `git diff` 执行失败（例如文件是新增的，尚未被 Git 追踪），函数返回空数组。

[来源](src/utils/diff.ts#L43-L67)

---

## 三、行区间交集：`rangesOverlap`

`rangesOverlap(pageRanges, changedRanges)` 是依赖匹配的核心算法。它判断两个行区间列表**是否存在任何重叠**。

```ts
for (const [ps, pe] of pageRanges) {
  for (const [cs, ce] of changedRanges) {
    if (ps <= ce && pe >= cs) return true;
  }
}
return false;
```

**算法本质**：两个区间 `[ps, pe]` 和 `[cs, ce]` 有交集 ⇔ **一个区间的起点不大于另一个区间的终点**。即 `ps ≤ ce && pe ≥ cs`。

这是一个典型的 **区间碰撞检测** 问题，时间复杂度 O(n×m)，但由于每个页面的依赖区间和 hunk 数量通常都很小（个位数），实际性能开销可以忽略。

[来源](src/utils/diff.ts#L69-L79)

---

## 四、发现受影响页面：`getAffectedSlugs`

`getAffectedSlugs(pageDeps, changedFiles, cwd, oldCommit)` 是依赖追踪的终端判断入口。它遍历所有变更文件，对每个文件执行以下逻辑：

### 分支 1：删除或重命名文件

文件已不在磁盘上，无法计算行级差异。采用**保守策略**：所有曾经引用过此文件的页面都被标记为受影响。

```ts
for (const [slug, deps] of Object.entries(pageDeps)) {
  if (deps[cf.path]) affected.add(slug);
}
```

### 分支 2：修改文件

1. 调用 `getChangedRanges` 获取此文件的变更行区间列表。
2. 遍历 `pageDeps`，找到所有依赖此文件的页面。
3. 对每个页面，将其记录的依赖行区间与变更行区间做 `rangesOverlap` 判断。
4. 若有交集，则该页面受此次变更影响。

最终返回一个 `Set<string>`，包含所有受影响的页面 slug。

[来源](src/utils/diff.ts#L81-L107)

---

## 五、依赖追踪的注入时机

精准依赖判断的前提是提前记录每个页面**读了哪些文件的哪些行**。这个记录发生在 `src/commands/generate.ts` 的 `collectFullResponse` 中。

### 全局变量

```ts
let _currentPageSlug: string | null = null;
const _pageDeps: Record<string, Array<{ file: string; lines: [number, number] }>> = {};
```

- `_currentPageSlug`：当前正在生成的页面 slug，在 `generatePages` 中每个页面开始前设置，完成后清空。
- `_pageDeps`：累积所有页面的依赖记录。

### 拦截 `read_file` 工具调用

在 `collectFullResponse` 的 tool call 循环中，每次调用 `read_file` 时：

```ts
if (_currentPageSlug && tc.function.name === 'read_file' && args.file_path) {
  const startLine = args.start_line || 1;
  const endLine = args.end_line || 999999;
  if (!_pageDeps[_currentPageSlug]) _pageDeps[_currentPageSlug] = [];
  _pageDeps[_currentPageSlug].push({ file: args.file_path, lines: [startLine, endLine] });
}
```

这意味着 LLM 在撰写某个页面时，一旦调用了 `read_file` 工具读取源文件的某个行区间，该区间就会被记录为该页面的依赖。

[来源](src/commands/generate.ts#L408-L414)

---

## 六、依赖持久化与恢复

### 写入

页面生成完成后，`savePageMetadata` 将 `_pageDeps` 聚合去重后写入 `.page-deps.json`：

- 同一文件的重叠行区间会被**合并**为一个更大的区间（通过 `merge` 逻辑）。
- 同时写入 `.page-content.json` 保存页面内容缓存。

### 读取

增量更新启动时，`resolveUpdateTarget` 从 `.wiki/<latest-version>/.page-deps.json` 读取旧依赖数据，与当前的 `getChangedFiles` 结果一起传入 `getAffectedSlugs`。

这个机制构成了增量更新的闭环：

```mermaid
flowchart LR
    A[读取旧 .page-deps.json] --> B[getChangedFiles]
    B --> C[getAffectedSlugs]
    C --> D[确定受影响页面]
    D --> E[LLM 分析更新计划]
    E --> F[重新生成受影响页面]
    F --> G[写入新 .page-deps.json]
```

[来源](src/commands/generate.ts#L1017-L1037)

---

## 设计决策解读

| 决策 | 原因 |
|------|------|
| 行级 vs 文件级依赖 | 文件级粒度太粗：一个 3000 行的源文件可能只改了 1 行，但所有引用它的页面都得重写。行级粒度将更新量降到最低。 |
| 删除/重命名保守策略 | 文件消失后 Git diff 无法给出 hunk，与其漏掉需要更新的页面，不如全部标记。保守比遗漏安全。 |
| 依赖在**页面生成时**记录 | 这是唯一可以精确捕捉 LLM 实际读了哪些代码的时机。如果改为事后静态分析，无法得知 LLM 的阅读偏好。 |
| 区间合并 | 同一页面可能多次调用 `read_file` 读取同一文件的邻近区域，合并后减少存储和匹配开销。 |

[来源](src/commands/generate.ts#L1040-L1054)

---

## 下一步

- 了解增量更新的完整调度流程：[增量更新：--update 模式](增量更新-update-模式.md)
- 查看生成引擎如何编排页面：[两阶段生成引擎](两阶段生成引擎.md)
- 探索基于状态对比的版本管理：[查看状态](查看状态.md)