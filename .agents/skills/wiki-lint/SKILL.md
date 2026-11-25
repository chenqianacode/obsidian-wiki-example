---
name: wiki-lint
description: 对 project-wiki/ 执行 Schema、双链、同名冲突、时效性、CRUD/服务对称性及跨文档冲突体检，输出分层修复清单。
---

# Wiki 体检（Lint）

## 步骤
1. **运行 0-token 结构体检脚本**：
   ```bash
   node project-wiki/scripts/lint.mjs
   ```
2. **读取体检报告与问题页**：
   - 读取 `project-wiki/wiki/_reports/lint报告.md`。
   - 读取 `project-wiki/wiki/questions/` 下所有 `status: "open"`（待拍板）与 `status: "decided"`（待改原文档）的问题页。
3. **可选语义深度检查**（当用户要求“全面检查”或“深度核对冲突”时）：
   - 对比 `wiki/tables/` 中的列名、类型、枚举值与 `wiki/features/` 正文中的字段引用，核查是否存在拼写偏差或未定义状态码。
   - 检查是否存在中英文同义重复建页（如同一概念建了两页而未合并到 `aliases`）。
4. **输出分层可执行清单（先汇报，不擅自改原文档）**：
   - 🔴 **阻塞性错误与真冲突**：Frontmatter 语法错误 / 同名冲突 / 断链 / CRUD 与服务归属不一致 / 错误码重号 / 待拍板跨文档冲突（`open`） / 缺失关键表定义（`missing-def`）。
   - 🟡 **同步与时效告警**：尚未摄入的新文档 / 过期未同步文档 / `valid_until` 已到期但仍标为 `active` 的临时规则。
   - 🔵 **文档回写债与低优项**：已由 CR 拍板但旧设计文档待修订项（`decided` / `pending-doc`） / 孤立页面。
   - 每条给出明确处理建议（修 Wiki 链接/格式、找业务负责人出 CR 决议、还是通知原文档作者回写修订），经用户确认修复 Wiki 后重新运行 `build-index.mjs` 与 `lint.mjs` 验证清零。
