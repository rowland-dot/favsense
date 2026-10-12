## 解决什么问题

<!-- 用一两句话说明用户遇到的问题。 -->

## 做了什么

<!-- 列出关键改动，避免粘贴完整提交记录。 -->

## 如何验证

生命周期检查按正文自动选择路径，二选一：

- **关闭已 triage 的 issue**（带 `ready-for-agent` 标签）：issue 的 agent brief 就是规格与计划。正文写 `Fixes #N`，下面的 `## Test plan` 至少有一个已勾选的 `- [x]` 测试项，再写 `Rollback:` 行并勾选 `- [x] Rollback reviewed`。不需要填 Spec 到 Review brief 的七个字段。
- **其他触及受治理路径的 PR**：按「回滚与文件证据」一节填写 Spec 到 Review brief 的文件证据链。

## Test plan

- [ ] `npm run release:check`（Node、两套 Python 测试与公开发布边界均通过）
- [ ] 涉及 Windows 安装/启动脚本时，Windows CI 契约已通过
- [ ] 如有界面变化，已检查桌面、移动端、键盘操作并附截图
- [ ] 如有采集变化，已确认仍为只读且遇到风控立即停止

## 回滚与文件证据

Spec: <!-- docs/specs/...-spec.md；关闭 ready-for-agent issue 时可删去 -->
Plan: <!-- docs/plans/...-plan.md -->
RED/GREEN evidence: <!-- docs/reports/code/...-code.md -->
Review: <!-- docs/reports/reviews/...-review.md -->
QA: <!-- docs/reports/qa/...-qa-report.md -->
Audit: <!-- docs/reports/test-outcomes/...-test-outcome.md -->
Review brief: <!-- docs/reports/briefs/...-brief.md -->
Rollback: <!-- exact revert/snapshot rollback statement -->

- [ ] Rollback reviewed
- [ ] Spec is APPROVED and the plan cites it（文件证据链路径）
- [ ] Privacy/public-tree checks pass
- [ ] User approved PR creation after the review brief（文件证据链路径）

## 隐私与安全

<!-- 说明是否接触 Cookie、Token、个人主页、收藏夹 ID、视频或帧文件。 -->

## 发布影响

<!-- 是否需要迁移配置、重装用户脚本或更新文档？没有请写“无”。 -->
