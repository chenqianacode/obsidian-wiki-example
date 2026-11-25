# 项目 Wiki 维护规则

本仓库是纯 Skill 驱动的设计文档知识库（Obsidian vault，参考 Karpathy LLM Wiki 模式）。
**所有语义理解与写作由 Agent 通过 `.agents/skills/` 完成；`scripts/` 里只保留 4 个不调用模型的 0-token 确定性辅助脚本。**

## 目录结构
- `raw/docs/`（或 `wiki.config.json` 中配置的 `docsDir`）：原始设计文档，**只读**
- `.sync-state.json`：记录上次已同步到的设计文档仓库 commit 水位线
- `wiki/sources/`：每篇文档一页摘要（`src-<文档名>.md`；跨目录同名文档加目录前缀消歧）
- `wiki/tables/`：物理表知识页（大写表名如 `T_MEMBER.md`）
- `wiki/features/`：功能页（HTTP API / 内部接口 / MQ 消费 / 定时批处理 / 画面）
- `wiki/modules/`：微服务、模块、外部系统、中间件
- `wiki/terms/`：业务术语与跨功能通用业务规则
- `wiki/questions/`：跨文档冲突与待修订文档债跟踪页
- `wiki/faq/`：由高频问答沉淀的结论页
- `index.md`、`wiki/_indexes/`（`CRUD矩阵`、`接口与消息总表`、`错误码字典`、`文档对照表`）、`wiki/_reports/lint报告.md`：由脚本自动生成，**请勿手改**

## 真相层级与冲突演进生命周期
1. **总体层级**：原始设计文档 > wiki。wiki 只负责结构化整理、交叉核对和溯源链接，不凭空捏造规则。
2. **文档内部演进**：正式生效的《变更与评审决议（CR）》> 旧版《基础设计（BD）》/《详细设计（DD）》/《表定义》。
3. **三态问题生命周期（区分“真冲突”与“文档回写债”）**：
   - **待拍板冲突（`question: open` / 实体页 `contested`）**：多份文档说法矛盾且尚无正式评审决议拍板。在实体页 `## ⚠️ 待确认` 并列各方说法与来源，绝不悄悄取舍。
   - **已决议待改原文档（`question: decided` / 实体页 `pending-doc`）**：`CR` 已正式拍板新口径，但旧 `BD/DD/表定义` 原文尚未同步修改。实体页正文采用最新生效决议，同时在 `## 📝 待同步回原文档` 列出待修订的原文档，防止文档债隐身（若该实体同时还存在其他未拍板冲突，则保持 `contested`）。
   - **已闭环（`question: resolved` / 实体页 `active`）**：旧原文档已在后续版本完成同步修订，冲突彻底消除。
4. **临时规则时效管理**：大促等带期限的临时文档在 `source` 页设置 `valid_until: "YYYY-MM-DD"`；到期后由 `lint.mjs` 提醒复核，确认恢复常规口径后将 `source` 页标为 `status: "expired"`。

## 硬性维护规则
1. 永远不修改原始设计文档目录（`raw/docs/`）和 `personal/`。
2. 每条事实性陈述末尾用 `（[[src-xxx]]）` 注明来源；双链统一用 `[[页面名]]`，新建前先查 `index.md` 或跑 `search.mjs` 检查名称与 `aliases` 防止重名。
3. **单向维护、反向派生（消除双写漂移）**：
   - 只在实体页/问题页/FAQ 的 frontmatter 维护 `sources: ["[[src-...]]"]`，`source` 页无需手写 `entities`（由 `build-index.mjs` 反向聚合）。
   - `feature` 页的 `crud` **仅记录本服务直连数据库**的表操作（如 `["T_MEMBER:CR"]`）；跨服务/跨功能的 HTTP 或 MQ 调用记入 `calls: ["[[目标功能]]"]`，同时维护 `entrypoints` 与 `error_codes`。
4. **Frontmatter 规范**：所有字段值统一使用**单行 JSON 语法**（如 `sources: ["[[src-a]]"]`），禁止多行 YAML 列表。
5. **状态枚举（`status`）**：
   - `source` 页：`"active"` | `"expired"` | `"deleted"`
   - 实体页：`"active"`（正常，兼容旧 `"draft"`）| `"verified"`（人工已核验）| `"contested"`（有未拍板冲突）| `"pending-doc"`（已决议待改原文档）| `"missing-def"`（仅从设计反推、缺正式表定义文档）| `"needs-review"`（来源文档被删）
   - `question` 页：`"open"` | `"decided"` | `"resolved"`
6. 每次修改 wiki 后执行（在 `project-wiki/` 外层加 `project-wiki/` 前缀）：
   - `node scripts/build-index.mjs`（重建 `index.md` 与 `wiki/_indexes/*.md`）
   - `node scripts/lint.mjs`（生成 `wiki/_reports/lint报告.md`，确保语法/断链/重名/一致性错误清零）
   并向 `log.md` 追加一条操作记录。
