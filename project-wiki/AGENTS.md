# 项目 Wiki 维护规则

本仓库是纯 Skill 驱动的设计文档知识库（Obsidian vault，参考 Karpathy LLM Wiki 模式）。
**所有语义理解与写作由 Agent 通过 `.agents/skills/` 完成；`scripts/` 里只保留 5 个不调用模型的 0-token 确定性辅助脚本（`sync-diff`、`build-index`、`lint`、`search`、`check-sync-hook`）。**

## 目录结构
- 原始设计文档目录（由 `wiki.config.json` 的 `docsDir` 或 `docsDirs` 配置，支持单目录、同仓多目录或跨多仓库）：**只读**
- `.sync-state.json`：按文档源记录上次已同步到的 Git commit 水位线（v2 格式，兼容旧版单目录格式）
- `wiki/sources/`：每篇文档一页摘要（`src-<文档名>.md`；跨目录或跨文档源同名时加文档源/子目录前缀消歧；多目录模式下 `doc_path` 使用 `<id>:<相对路径>`）
- `wiki/tables/`：物理表知识页（大写表名如 `T_MEMBER.md`）
- `wiki/features/`：功能页（HTTP API / 内部接口 / MQ 消费 / 定时批处理 / 画面）
- `wiki/modules/`：微服务、模块、外部系统、中间件
- `wiki/terms/`：业务术语与跨功能通用业务规则
- `wiki/questions/`：跨文档冲突与待修订文档债跟踪页
- `wiki/faq/`：由高频问答沉淀的结论页
- `index.md`、`wiki/_indexes/`（`CRUD矩阵`、`接口与消息总表`、`错误码字典`、`文档对照表`）、`wiki/_reports/lint报告.md`：由脚本自动生成，**请勿手改**

## 真相层级与冲突演进生命周期
1. **总体层级**：线上代码 / 真实 DDL（涉及代码改造时需核对）与原始设计文档 > wiki。wiki 只负责对设计文档做结构化整理、交叉核对和溯源链接，不凭空捏造规则。
2. **文档内部演进**：正式生效的《变更与评审决议（CR）》> 旧版《基础设计（BD）》/《详细设计（DD）》/《表定义》。
3. **三态问题生命周期（区分“真冲突”与“文档回写债”）**：
   - **待拍板冲突（`question: open` / 实体页 `contested`）**：多份文档说法矛盾且尚无正式评审决议拍板。在实体页 `## ⚠️ 待确认` 并列各方说法与来源，绝不悄悄取舍。
   - **已决议待改原文档（`question: decided` / 实体页 `pending-doc`）**：`CR` 已正式拍板新口径，但旧 `BD/DD/表定义` 原文尚未同步修改。实体页正文采用最新生效决议，同时在 `## 📝 待同步回原文档` 列出待修订的原文档，防止文档债隐身（若该实体同时还存在其他未拍板冲突，则保持 `contested`）。
   - **已闭环（`question: resolved` / 实体页 `active`）**：旧原文档已在后续版本完成同步修订，冲突彻底消除。
4. **人工核验降级规则**：若已标为 `status: "verified"`（人工已核验）的实体页在后续 `wiki-sync` 中因原文档修改而发生实质性变更，应将其状态降级为 `"needs-review"`（或无争议且经用户确认后恢复 `"active"`），避免过期结论继续挂着“已核验”标记。
5. **临时规则时效管理**：大促等带期限的临时文档在 `source` 页设置 `valid_until: "YYYY-MM-DD"`；到期后由 `lint.mjs` 提醒复核，确认恢复常规口径后将 `source` 页标为 `status: "expired"`。

## 硬性维护规则
1. 永远不修改原始设计文档目录和 `personal/`。
2. 每条事实性陈述末尾用 `（[[src-xxx]]）` 注明来源；双链统一用 `[[页面名]]`，新建前先查 `index.md` 或跑 `search.mjs` 检查名称与 `aliases` 防止重名。
3. **单向维护、反向派生（消除双写漂移）**：
   - 只在实体页/问题页/FAQ 的 frontmatter 维护 `sources: ["[[src-...]]"]`，`source` 页无需手写 `entities`（由 `build-index.mjs` 反向聚合）。
   - `feature` 页的 `crud` **仅记录本服务直连数据库**的表操作（如 `["T_MEMBER:CR"]`）；跨服务/跨功能的 HTTP 或 MQ 调用记入 `calls: ["[[目标功能]]"]`，同时维护 `entrypoints` 与 `error_codes`。
   - **括号与冒号约定**：`sources`、`calls`、`related` 使用双链数组 `["[[目标页]]"]`；`service` 与 `crud` 中的表名使用裸名（如 `service: "积分服务"`、`crud: ["T_MEMBER:CR"]`），分隔符统一使用半角冒号 `:`。
4. **Frontmatter 规范**：Agent 写入时推荐使用**单行 JSON 语法**（如 `sources: ["[[src-a]]"]`）；解析脚本同时原生兼容 Obsidian Properties 面板或重命名操作自动写回的标准多行 YAML 列表与单引号标量。
5. **状态枚举（`status`）**：
   - `source` 页：`"active"` | `"expired"` | `"deleted"`
   - 实体页：`"active"`（正常，兼容旧 `"draft"`）| `"verified"`（人工已核验）| `"contested"`（有未拍板冲突）| `"pending-doc"`（已决议待改原文档）| `"missing-def"`（仅从设计反推、缺正式表定义文档）| `"needs-review"`（来源文档被删或已核验实体发生变更待复核）
   - `question` 页：`"open"` | `"decided"` | `"resolved"`
6. 每次修改 wiki 后执行（在 `project-wiki/` 外层加 `project-wiki/` 前缀）：
   - `node scripts/build-index.mjs`（重建 `index.md` 与 `wiki/_indexes/*.md`，无内容变化时不改动时间戳）
   - `node scripts/lint.mjs`（生成 `wiki/_reports/lint报告.md`，确保配置/Schema/断链/重名/关系/状态机错误清零；CI 场景可用 `--strict`）
   并向 `log.md` 追加一条操作记录。
