---
name: wiki-query
description: 查询 project-wiki 里的项目设计知识（表定义、功能流程、接口契约、错误码、模块职责、术语、冲突与决议）。在写设计文档或改代码前核对字段/状态码/影响范围时使用。
---

# Wiki 问答与核对

当用户提问或需要核对项目设计细节时，按以下步骤执行：

## 步骤
1. **快速检索与影响面定位（0 token）**：
   - 按关键词、类型或状态检索：
     ```bash
     node project-wiki/scripts/search.mjs <关键词1> [关键词2...] [--type=table|feature|module|term|question|source|faq] [--status=contested|open|pending-doc]
     ```
   - 改表结构 / 改接口前评估上下游影响面（2 跳 CRUD + 调用链 + 未闭环问题）：
     ```bash
     node project-wiki/scripts/search.mjs --impact=<表名或功能名或模块名>
     ```
   - 若需全局概览，读取 `project-wiki/index.md`；按问题类型辅读专项索引：
     - 查表读写影响范围：`project-wiki/wiki/_indexes/CRUD矩阵.md`
     - 查 HTTP/内部接口/MQ/定时任务及调用链：`project-wiki/wiki/_indexes/接口与消息总表.md`
     - 查业务错误码是否重号：`project-wiki/wiki/_indexes/错误码字典.md`
2. **精读相关知识页（通常 3～8 页）**：
   - 表定义：`wiki/tables/<表名>.md`
   - 功能设计：`wiki/features/<功能名>.md`
   - 模块架构：`wiki/modules/<模块名>.md`
   - 术语规则：`wiki/terms/<术语名>.md`
   - 冲突与决议：`wiki/questions/<问题>.md`
3. **必要时回溯原文与代码核对**：
   - 若 Wiki 页面细节不足、标为 `missing-def` 或存在歧义，通过 `[[src-...]]` 查 `wiki/sources/` 中的 `doc_path`（多目录模式结合 `wiki.config.json` 的 `docsDir`/`docsDirs` 定位目录），直接读取原始设计文档核实。
   - **信任边界**：Wiki 反映的是设计文档共识；如果当前任务是**修改线上代码**，在落地改动前应抽查对应真实代码 / DDL，若发现设计与线上实现不一致，以线上代码为准并提醒用户存在文档偏差。
4. **严谨组织回答**：
   - 只基于已读到的内容作答，绝不编造字段名、状态码或阈值。
   - 每个关键结论附上双链引用，如 `[[T_POINT_LEDGER]]`、`[[src-DD-02_积分发放]]`。
   - **区分冲突与已决议项**：
     - 若属于未拍板冲突（`contested` / `question: open`），**必须并列指出各方说法与来源**，不替用户擅自裁决；
     - 若属于已决议待改原文档（`pending-doc` / `question: decided`），**明确给出最新生效决议**，同时提醒哪份旧设计文档尚未回写修订；
     - 若信息缺失（如 `missing-def` 缺少表定义），明确指出缺少哪份文档。
5. **可选沉淀 FAQ**：若该结论具有长期复用价值（或用户要求保存）：
   - 写入 `project-wiki/wiki/faq/<简短问题名>.md`（推荐单行 JSON 风格 frontmatter：`type: "faq"`、`title`、`summary`、`related`、`sources`、`status: "active"`、`created`、`updated`）。
   - 运行 `node project-wiki/scripts/build-index.mjs` 与 `node project-wiki/scripts/lint.mjs`，并在 `project-wiki/log.md` 追加记录。
