# Project LLM Wiki 使用指南（既有项目接入版）

> 参考 Karpathy「LLM Wiki」模式，面向**既有项目的中大规模 Markdown 设计文档**（基础设计、详细设计、表定义、变更与评审等）。  
> **纯 Skill 驱动 + 5 个 0-token 确定性脚本**：直接复用你正在用的 Codex / Claude Code / Antigravity / Gemini CLI / Cursor，无需单独配置 API Key；用 Obsidian 浏览知识页、CRUD 矩阵、接口总表、错误码字典与关系图谱。

---

## 1. 套件结构

```text
<你的项目根目录>/
├── AGENTS.md                        ← 多 Agent 项目入口（Codex / Antigravity / Cursor 原生读取）
├── CLAUDE.md                        ← 仅一行 @AGENTS.md（Claude Code 读取）
├── GEMINI.md                        ← 指向 AGENTS.md（Gemini CLI 读取）
├── .claude/settings.json            ← Claude Code SessionStart Hook（检测受监控文档变更时先问用户）
├── .gemini/settings.json            ← Gemini CLI SessionStart Hook（同上，JSON 输出 + 5000ms 超时）
├── .agents/skills/                  ← 唯一技能目录（所有 Agent 共用）
│   ├── wiki-ingest/SKILL.md         ← 首次或分批摄入设计文档
│   ├── wiki-sync/SKILL.md           ← 基于 git diff 增量同步文档变更
│   ├── wiki-query/SKILL.md          ← 查表/接口/错误码/影响面与冲突，可沉淀 FAQ
│   └── wiki-lint/SKILL.md           ← 配置、Schema、状态机、时效性与一致性体检
├── docs/                            ← 你的既有设计文档目录（支持多目录/多仓库，只读不改动）
└── project-wiki/                    ← Obsidian 只打开这个子目录
    ├── AGENTS.md                    ← Wiki 维护宪法与三态冲突生命周期
    ├── wiki.config.json             ← 文档目录（单/多目录）、扩展名、排除项、摄入顺序配置
    ├── .sync-state.json             ← 按文档源记录的上次同步 git commit 水位线
    ├── package.json                 ← npm run diff / pending / index / lint / lint:strict / search
    ├── index.md                     ← 自动生成的总索引
    ├── log.md                       ← 操作日志（只追加）
    ├── scripts/                     ← 5 个 0-token 纯 Node.js 脚本（零第三方依赖）
    ├── wiki/                        ← Agent 维护的知识页 + 自动生成的 _indexes / _reports
    └── .obsidian/                   ← 已配好图谱分色、排除索引页毛线球与忽略脚本目录
```

**前置环境**：Node.js 18+、Git、Obsidian（仅用于可视化浏览；脚本原生兼容 Obsidian Properties 面板自动写回的多行 YAML）。

---

## 2. 接入既有项目（5 步上手）

### 第 1 步：复制骨架到你的项目根目录

从本目录复制以下内容到 `<你的项目根目录>`：

1. **复制技能目录**：将 `.agents/skills/` 下的 4 个 `wiki-*` 文件夹复制到 `<你的项目根目录>/.agents/skills/`。
2. **复制 `project-wiki/` 骨架**（**不要**复制 demo 里的 `wiki/` 和 `raw/docs/`）：
   - `project-wiki/AGENTS.md`
   - `project-wiki/wiki.config.json`
   - `project-wiki/package.json`
   - `project-wiki/.gitignore`
   - `project-wiki/.obsidian/`
   - `project-wiki/scripts/`
   - 新建一个空的 `project-wiki/log.md`（写一行 `# 操作日志` 即可）。
3. **合并项目入口规则**：把根目录 `AGENTS.md` 中的「写文档 / 改代码前」与「可用 Wiki 技能」两节合并进你项目现有的 `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`（如果没有则直接复制这 3 个文件）。

### 第 2 步：修改 `project-wiki/wiki.config.json`

按你的设计文档存放方式三选一：

**情况 A：单目录，设计文档就在当前项目仓库里（最常见，例如 `docs/`）**
```json
{
  "docsDir": "../docs",
  "docsBranch": "main",
  "extensions": [".md"],
  "exclude": ["README.md", "archive/"],
  "order": ["01_基础设计", "03_表定义", "02_详细设计", "04_变更与评审"]
}
```
> 同仓子目录模式下，水位线仅追踪触及该文档目录的提交（业务代码提交不会触发误报），且不会擅自 `fetch` 或切换当前仓库分支。

**情况 B：设计文档在另一个独立 Git 仓库**
```powershell
git -C project-wiki submodule add <文档仓库地址> raw/docs
```
`wiki.config.json` 设为 `"docsDir": "raw/docs"`，按实际主分支修改 `"docsBranch"`（`main` 或 `master`）。

**情况 C：设计文档分布在多个目录（同仓多目录 / Monorepo / 混合外部文档仓）**
支持直接给 `docsDir` 传路径数组，或用 `docsDirs` 显式指定每个目录的 `id` 与 `branch`：
```json
{
  "docsDirs": [
    { "id": "arch", "path": "../docs" },
    { "id": "order", "path": "../services/order/docs" },
    { "id": "shared", "path": "raw/shared-docs", "branch": "master" }
  ],
  "extensions": [".md"],
  "exclude": ["README.md", "archive/", "order:drafts/", "./CHANGELOG.md"],
  "order": ["arch:", "01_基础设计", "03_表定义", "02_详细设计", "04_变更与评审"]
}
```
- **多目录机制说明**：
  - 每个文档源在 `.sync-state.json` 中独立记录 commit 水位线，互不干扰（同仓多目录与跨仓库混用均可）。
  - `wiki/sources/` 中的 `doc_path` 自动带上 `<id>:<相对路径>` 前缀（如 `order:02_详细设计/下单.md`），避免跨目录路径冲突；若存在同名文件，`sync-diff.mjs --pending` 会自动建议带前缀的 `src-<id>-<文档名>.md`。
  - 若从单目录平滑扩展为多目录，脚本会自动兼容识别旧无前缀 `doc_path` 并由 `lint.mjs` 提示补充前缀。
- **`exclude` 规则支持**：目录前缀（`archive/`）、根相对路径（`./README.md` 仅排除根目录）、通配符（`*.draft.md`）、文档源限定（`order:drafts/`）以及按文件名匹配（`README.md`）。

### 第 3 步：让多 Agent 共享同一份 Skill

- **Codex / Antigravity / Gemini CLI / Cursor**：原生自动识别 `.agents/skills/`，无需额外操作。
- **Claude Code**：默认读取 `.claude/skills/`，在项目根目录建一次目录联接即可复用（只维护一份）；同时复制 `.claude/settings.json` 启用 `SessionStart` 同步检测 Hook：
  - **Windows（PowerShell）**：
    ```powershell
    New-Item -ItemType Directory -Force .claude | Out-Null
    cmd /c mklink /J .claude\skills .agents\skills
    ```
  - **macOS / Linux**：
    ```bash
    mkdir -p .claude && ln -s ../.agents/skills .claude/skills
    ```
- **Gemini CLI**：复制 `.gemini/settings.json` 即可在会话开始时自动执行 `SessionStart` Hook（已配好 `--format=gemini` JSON 协议与 `5000ms` 超时）。
- **Codex / Antigravity / Cursor**：按 `AGENTS.md` 中的「会话开始自检」规则在需要时调用 `node project-wiki/scripts/check-sync-hook.mjs`。

> **Hook 行为说明**：会话启动时纯本地运行 `check-sync-hook.mjs`（不联网、耗时 <100ms）。仅当受监控设计文档存在真实改动或尚未初始化时才输出提醒，普通代码提交完全静默；在用户明确确认前不会擅自修改 wiki。

### 第 4 步：个人试用阶段不污染团队 Git

在还没打算推给全员之前，把以下条目追加到 `<你的项目根目录>/.git/info/exclude`（只对你本地生效，不修改团队共享的 `.gitignore`）：

```text
project-wiki/
.agents/skills/wiki-ingest/
.agents/skills/wiki-sync/
.agents/skills/wiki-query/
.agents/skills/wiki-lint/
.claude/skills
.claude/settings.json
.gemini/settings.json
AGENTS.md
CLAUDE.md
GEMINI.md
```
> 若你项目原本已有 `AGENTS.md` / `CLAUDE.md` / `.claude/settings.json`，请不要把它们加入 exclude，改为只排除新增的 `project-wiki/` 与 `.agents/skills/wiki-*`。

### 第 5 步：用 Obsidian 打开知识库

在 Obsidian 中选择 **“打开本地仓库”** → 选中 `<你的项目根目录>/project-wiki`（不要选整个项目根目录，避免扫描源码和 `node_modules`）。

---

## 3. 日常使用工作流

### ① 首次建库（`wiki-ingest`）

直接在项目根目录的 Agent 对话框里触发：
- 文档 ≤ 20 篇：`请用 wiki-ingest 技能摄入全部设计文档`
- 文档上百篇（**强烈建议分批**）：
  1. 先用 `npm --prefix project-wiki run pending -- --limit=10` 查看按 `order` 排序的下一批待摄入清单（0 token，自带 `doc_commit` 与消歧文件名）。
  2. 对 Agent 说：`请用 wiki-ingest 摄入下一批 10 篇文档`。
  3. 每批结束后自动执行 `build-index`、`lint` 与 `sync-diff --advance`：**分批中途 `--advance` 会自动检测剩余未摄入文档并暂缓推进全局水位线**，直到该文档源全部摄入完毕才锁定水位线，杜绝漏同步。

### ② 写文档 / 改代码前核对（`wiki-query`）

在项目根目录写设计或改代码时，随时问 Agent：
- `用 wiki-query 查一下 T_POINT_LEDGER 有哪些功能在读写，字段名有没有历史冲突？`
- `用 wiki-query 查一下现在已用的错误码前缀有哪些，避免重号`

也可以在终端 0-token 秒查或做影响面分析：
```bash
node project-wiki/scripts/search.mjs EXC-004
node project-wiki/scripts/search.mjs T_POINT_LEDGER --type=table
node project-wiki/scripts/search.mjs --status=contested
node project-wiki/scripts/search.mjs --impact=T_POINT_LEDGER
```

### ③ 文档更新后增量同步（`wiki-sync`）

设计文档有新提交（或 `git pull` 拉取了同事的文档改动）后：
1. 在 Agent 中说：`用 wiki-sync 同步最新文档变更`。
2. `sync-diff.mjs` 会按文档源对比 `.sync-state.json` 水位线，自动过滤纯空白/格式修改，并列出受影响的实体页，Agent 只更新变化的部分并补充核查新关联实体。
3. 完成后自动重建索引、`lint` 验错并推进 `.sync-state.json`。

### ④ 定期体检（`wiki-lint`）

发版前或每周一次，在 Agent 中说：`用 wiki-lint 做一次体检`。

冲突按**三态生命周期**管理，并由 `lint.mjs` 自动校验跨页状态机一致性：
- `open` / `contested`：多篇文档矛盾且尚未拍板（需找负责人决策）
- `decided` / `pending-doc`：已有 CR 评审拍板，但旧设计文档尚未回写修订
- `resolved` / `active`：旧文档已同步修订，彻底闭环

---

## 4. 常用脚本速查（均在 `project-wiki/` 下，0 token）

| 命令 | 作用 |
|---|---|
| `npm run diff` | 按文档源对比 `.sync-state.json` 与最新提交，生成 `.cache/changes.md`（支持 `--source=<id>`） |
| `npm run pending` | 按 `order` 列出待首次摄入文档、磁盘路径、`doc_commit` 与建议摘要页名（支持 `--limit=10`） |
| `node scripts/sync-diff.mjs --advance` | 校验无漏摄入/过期页后，将 `.sync-state.json` 水位线推进到最新提交（可加 `--force` 强制推进） |
| `npm run index` | 重建 `index.md`、`CRUD矩阵.md`、`接口与消息总表.md`、`错误码字典.md`、`文档对照表.md` |
| `npm run lint` | 执行配置、Schema、同名/别名、断链、孤立页、CRUD/服务对称性、状态机、错误码重号、过期文档体检 |
| `npm run lint:strict` | 严格模式体检（存在阻塞性错误时以非 0 退出码退出，适合 CI / MR 门禁） |
| `node scripts/search.mjs <关键词> [--type=...] [--status=...]` | 0-token 本地检索（支持归一化与中文 2-gram 回退匹配） |
| `node scripts/search.mjs --impact=<实体名>` | 0-token 上下游影响面分析（直连 CRUD 功能 + 上下游调用方 + 关联未闭环问题） |

---

## 5. 从个人使用推广到团队

1. **小范围试点**：从 `.git/info/exclude` 去掉相关条目，把 `project-wiki/` 与 `.agents/skills/` 一起提交到项目仓库（个人随手笔记放 `project-wiki/personal/`，已在 `.gitignore` 中忽略）。
2. **全员复用**：同事 `git pull` 后，用自己习惯的 Agent 就能直接 `/wiki-query`，用 Obsidian 打开 `project-wiki/` 即可看图谱与各类总表。
3. **只读网页发布（可选）**：给产品/测试等不用 Obsidian 的同事，可用 [Quartz](https://quartz.jzhao.xyz/) 将 `project-wiki/` 构建成内部静态网站（原生支持 `[[双链]]`、关系图谱与全文搜索）。
4. **维护分工**：建议由少数维护者（或 CI 定时任务配合 `npm run lint:strict`）执行 `wiki-sync` 并提 MR，其他人只改原始设计文档、不直接手改 `project-wiki/wiki/`，保持格式与引用零漂移。
