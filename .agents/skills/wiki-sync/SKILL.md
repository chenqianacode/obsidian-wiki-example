---
name: wiki-sync
description: 基于 .sync-state.json 同步水位线，将设计文档的新增、修改、重命名或删除增量同步到 project-wiki/，并重建索引与体检报告。
---

# Wiki 增量同步（Sync）

参考 `project-wiki/AGENTS.md` 与 `wiki-ingest` 技能的页面规范。

## 步骤

### 1. 生成增量变更清单并准备文档工作区（0 token）
```bash
node project-wiki/scripts/sync-diff.mjs
```
- 支持多文档目录（可加 `--source=<id>` 仅同步单个文档源）。
- 脚本会对比 `project-wiki/.sync-state.json` 与各文档目录最新有效提交：
  - **独立文档仓 / submodule**：自动尝试 fetch 并将工作区切到目标提交（推进前重复运行完全幂等）；
  - **同仓子目录**：严格以当前本地工作区 `HEAD` 中触及该目录的提交为准，不擅自切换分支或拉取未合并远端。
- 输出变更清单到终端与 `project-wiki/.cache/changes.md`，先向用户简报本次变更范围（若存在未提交本地改动或历史分叉告警，一并告知）。

### 2. 按变更类型逐项处理
- **新增**：按 `wiki-ingest` 流程新建 `wiki/sources/src-*.md`（填入清单给出的 `doc_path` 与 `doc_commit`）并创建/更新相关实体页。
- **修改**：
  1. 直接使用 `.cache/changes.md` 中为该文档源生成的命令（`git -C "<目录路径>" diff -w <oldRev> <newRev> -- "<rel_path>"`）查看具体差异，并按清单给出的文件路径阅读更新后的原文档全文。
  2. 更新对应 `wiki/sources/src-*.md` 的摘要、要点、`doc_commit`、`updated`（若为临时规则复核 `valid_until` / `status`）。
  3. 更新清单列出的“受影响页面”，**同时用 `search.mjs` 核查本次修改是否首次引用了此前未关联的已有表/功能/术语**，若存在新关联则一并更新这些实体页与 `sources`：
     - 替换来自该文档的旧陈述，保留其他来源的内容；
     - 若受影响实体原本是 `status: "verified"`（人工已核验）且核心规则发生实质变更，降级为 `"needs-review"` 并提醒用户复核；
     - 若产生新矛盾，写入 `## ⚠️ 待确认`（`contested`）并在 `wiki/questions/` 新增 `open` 问题；
     - 若本次修改是 `CR` 拍板决议，将对应问题更新为 `decided`（实体页无其他真冲突则标为 `pending-doc`）；
     - 若本次修改已将旧设计文档同步修订到位，将对应的 `decided` / `open` 问题闭环为 `resolved`，清理实体页的待办小节并恢复 `status: "active"`。
- **重命名**：
  1. 按需要重命名 `wiki/sources/src-<旧名>.md` 为 `src-<新名>.md`，更新其 `title`、`doc_path`、`doc_commit` 与原文链接。
  2. 在清单列出的所有“受影响页面”中，将 `[[src-<旧名>]]` 批量替换为 `[[src-<新名>]]`。
  3. 若文件重命名的同时伴随内容改动，按上述“修改”步骤同步更新实体内容。
- **删除**：将 `sources/` 页 `status` 标为 `"deleted"`，受影响实体页若失去唯一权威依据则标为 `"needs-review"`，并在 `wiki/questions/` 记录待确认事项。
- **仅格式变化**：只更新对应 `sources/` 页的 `doc_commit`，无需改动实体页。

> 严禁修改原始设计文档目录和 `project-wiki/personal/`。

### 3. 重建索引、校验体检并推进同步水位线
```bash
node project-wiki/scripts/build-index.mjs
node project-wiki/scripts/lint.mjs
node project-wiki/scripts/sync-diff.mjs --advance
```
确认结构、关系与状态机检查无阻塞性错误且水位线成功推进后，向 `project-wiki/log.md` 追加一条同步日志，向用户汇报本次同步结果、闭环的问题、需复核的 `verified` 页面及新发现的冲突。
