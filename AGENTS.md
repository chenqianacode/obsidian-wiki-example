# 项目指令（Wiki 协作）

本项目的 `project-wiki/` 是由 Agent 通过 Skill 维护的设计文档知识库（Obsidian vault）。

## 会话开始自检（同步水位线）
- 每次新会话开始时（Claude Code / Gemini CLI 会由 `SessionStart` Hook 自动执行；其他 Agent 可在首次处理涉及设计文档的任务前运行 `node project-wiki/scripts/check-sync-hook.mjs`）：
- 若检测到当前设计文档 Git commit 与 `project-wiki/.sync-state.json` 记录的水位线不一致，**必须先向用户简短确认是否需要先运行 `wiki-sync` 同步知识库**，在用户确认前不要擅自同步。

## 写文档 / 改代码前
- 涉及业务规则、表字段、状态码、接口契约、错误码或影响范围时，优先使用 `wiki-query` 技能（或运行 `node project-wiki/scripts/search.mjs <关键词>`），并核对：
  - 全局入口：`project-wiki/index.md`
  - 表读写边界：`project-wiki/wiki/_indexes/CRUD矩阵.md`
  - 接口与调用链：`project-wiki/wiki/_indexes/接口与消息总表.md`
  - 错误码防重：`project-wiki/wiki/_indexes/错误码字典.md`
- 详细维护规则与状态流转见 `project-wiki/AGENTS.md`。

## 可用 Wiki 技能（位于 `.agents/skills/`）
- `wiki-ingest`：首次或按批摄入设计文档，构建 `project-wiki/wiki/` 并初始化同步水位线。
- `wiki-sync`：基于 `.sync-state.json` 水位线将文档新增/修改/重命名/删除增量同步到 `project-wiki/`。
- `wiki-query`：基于 `project-wiki/` 回答问题、核对表定义/接口/错误码与业务规则，支持沉淀到 FAQ。
- `wiki-lint`：执行 Schema、双链、时效性、一致性体检，分层汇总待拍板冲突与待修订文档债。
