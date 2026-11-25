---
name: wiki-ingest
description: 首次或按批将项目设计文档（基础设计、表定义、详细设计、变更与评审等）摄入到 project-wiki/，生成文档摘要页与表/功能/模块/术语知识页，并分层识别跨文档冲突与文档回写债。
---

# Wiki 摄入（Ingest）

参考 `project-wiki/AGENTS.md` 与 `project-wiki/wiki.config.json`。

## 第 0 步：生成 0-token 待摄入批次清单
先运行脚本获取按 `order` 排好序的待摄入文档（含精确 `doc_path`、磁盘读取路径、`doc_commit` 与消歧后的建议 `src-` 页名），避免手动逐篇跑 `git log`：
```bash
node project-wiki/scripts/sync-diff.mjs --pending --limit=10
```
- 多文档目录配置下可加 `--source=<id>` 逐个目录摄入。
- 摄入顺序原则：**基础设计（骨架） → 表定义（权威列/枚举） → 详细设计（功能/CRUD/接口/错误码） → 变更与评审（CR 决议/临时规则）**。文档超过 20 篇时建议每批 5～10 篇。

## 单篇文档处理步骤
对本批每一篇待摄入文档：

1. **读原文与定位已有实体**：
   - 按 `--pending` 给出的磁盘路径读取原文档全文。
   - 页面总数 ≤ 100 时可直接读取 `project-wiki/index.md`；超过 100 页时优先运行 `node project-wiki/scripts/search.mjs <核心名词...>` 定位已有同名或同义实体，避免重复建页。
2. **写文档摘要页** `project-wiki/wiki/sources/<建议摘要页>.md`（直接使用 `--pending` 建议的 `src-` 文件名，跨目录或跨文档源同名时已自动加前缀消歧）：
   - 推荐单行 JSON 风格 frontmatter（无需手写 `entities`，由脚本反向统计）：
     ```yaml
     ---
     type: "source"
     title: "文档标题"
     doc_type: "基础设计 | 表定义 | 详细设计 | 变更与评审 | 其他"
     doc_path: "与 --pending 输出完全一致（多目录模式含 <id>: 前缀）"
     doc_commit: "直接填写 --pending 给出的 7 位 git hash"
     version: ""
     author: ""
     doc_date: ""
     valid_until: ""
     summary: "一句话摘要"
     status: "active"
     updated: "YYYY-MM-DD"
     ---
     ```
     > 注：常规长期有效文档省略 `valid_until`；若是限时活动规则则填 `"YYYY-MM-DD"`，若摄入时已过有效期则将 `status` 设为 `"expired"`。
   - 正文包含：原文路径与 commit、摘要、5～10 条关键要点（保留具体数值/字段名/状态码/接口路径）。
3. **创建或更新实体页**（只收录有实质信息的实体，同义词写入 `aliases`）：
   - `wiki/tables/<物理表名>.md`（`type: "table"`，`cn_name`，`db`）：列定义、索引、使用此表的功能表、业务规则。**若该表仅在设计流程中提及而缺少正式表定义文档，且无其他冲突，则 `status` 设为 `"missing-def"`**（后续摄入正式表定义后再改为 `"active"`）。
   - `wiki/features/<功能名>.md`（`type: "feature"`，`service: "模块名"`，`kind`，`entrypoints: ["API: POST /..."]`，`crud: ["T_XXX:CR"]`，`calls: ["[[下游功能]]"]`，`error_codes: ["CODE:说明"]`）：
     - **注意**：`service` 与 `crud` 表名写**裸名**（不加 `[[]]`），冒号用半角 `:`；`crud` **只填本服务直连数据库读写的表**，跨服务 HTTP/MQ 调用填在 `calls`（用 `[["..."]]`）。
     - 正文包含：基本信息、处理流程、使用的表（须与 `crud` 一致）、错误码与异常处理、相关。
   - `wiki/modules/<模块名>.md`（`type: "module"`，`tech`）：基本信息、负责的功能（须列出所有 `service` 指向它的功能双链）、依赖与接口。
   - `wiki/terms/<术语名>.md`（`type: "term"`）：定义、规则与数值、相关。
   - 所有实体页必填：`type`、`title`、`aliases`、`summary`、`sources`（追加 `"[[src-...]]"`）、`status`（正常填 `"active"`）、`updated`。正文中每条事实末尾标注 `（[[src-...]]）`。
4. **冲突与决议分层处理（重要）**：
   - **未拍板真冲突**：遇到数值、字段名、状态码或流程与已有文档矛盾且无正式决议时，**绝不悄悄覆盖**——在实体页写 `## ⚠️ 待确认` 并列各方说法，设实体页 `status: "contested"`，并在 `wiki/questions/<冲突主题>.md` 建页（`type: "question"`、`status: "open"`、`related`、`sources`）。
   - **已有 CR 正式决议但旧文档未改**：正文采用 `CR` 最新口径，在实体页写 `## 📝 待同步回原文档` 说明哪份旧文档待修订；对应 `question` 页设为 `status: "decided"`，若实体页无其他未拍板冲突则设为 `status: "pending-doc"`。

## 收尾
本批全部文档处理完毕后执行：
```bash
node project-wiki/scripts/build-index.mjs
node project-wiki/scripts/lint.mjs
node project-wiki/scripts/sync-diff.mjs --advance
```
- **分批保护说明**：`sync-diff.mjs --advance` 会自动检查每个文档源是否仍有未摄入或过期文档；分批中途会自动跳过推进全局水位线（避免漏同步剩余文档），等该文档源**全部首次摄入完成后**才会自动推进 `.sync-state.json`。
- 确保配置、Schema、断链、同名、关系与状态机错误为 0，在 `project-wiki/log.md` 追加一条记录，并向用户汇报本批处理篇数、剩余待摄入篇数、新建/更新页数、待拍板冲突与待修订文档债。
