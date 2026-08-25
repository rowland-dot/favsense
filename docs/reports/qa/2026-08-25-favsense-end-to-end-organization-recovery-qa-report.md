# FavSense 收藏整理端到端恢复 QA 报告

- 日期：2026-08-25
- 分支：`codex/favsense-organization-recovery`
- Step 6 起始提交：`b1abf258b0fb682b83352cd89f10152dfef585c4`
- QA 修复提交：`84cc434`、`d14de43`、`911baef`、`645e6b2`
- 范围：批准清单 `VC-QA-01..15`
- 数据边界：仅使用 `serve-qa-fixture.mjs` 的 synthetic fixture；未访问平台、网络主机、凭据或真实私有数据；未执行真实 migration apply。
- Mockup / trigger / callsite：批准计划没有 mockup，`MOCKUP_PATHS=[]`、`CALLSITE_LIST=[]`；因此没有 `data-mockup-state` 或 `data-mockup-trigger` 项。

## Outcome

Step 6 PASS。发现 2 个 MEDIUM QA 缺陷，均已按 Fix-First 完成 RED → GREEN、原子提交和全门回归；未修复缺陷为零。

- Baseline Playwright：30/30 PASS（desktop Chromium + mobile Chromium）。
- 修复后 Playwright：32/32 PASS（新增 QA-001 desktop/mobile 回归）。
- Step 6 code gate：`npm.cmd run release:check` exit 0。
- 最终未修复严重度：CRITICAL=0 HIGH=0 MEDIUM=0 LOW=0。

## State coverage — pre-walk

没有 tagged mockup states。以下 9 个批准的 synthetic application states 全部通过真实渲染入口走查：

1. `success`：同步设置 → 开始整理 → “内容无变化，无需发布”，核心保存文案存在。
2. `running-success`：轮询保持运行态，最终启用“再次整理”。
3. `partial`：核心保存状态不被增强阶段结果覆盖。
4. `summary-failed`：卡片与详情明确显示“本篇总结失败，可在下次继续”。
5. `batch-aborted`：卡片明确显示“本次未尝试，可继续整理”。
6. `stale`：明确显示“正文已变化，等待重新审核”。
7. `build-failed`：显示“构建失败，已保留上一版”，不声称完整成功。
8. `publish-failed`：显示“发布失败，远端仍为上一版；本地结果已保留”。
9. `safety-stopped`：显示安全停止与人工检查指引，按钮变为“检查后重试”。

每次浏览器交互后均检查 console；未观察到意外 console error。预走查没有使用真实平台、外部 URL 请求或真实收藏数据。

## Triggers exercised

批准计划没有 mockup trigger，故 trigger exhaustion 为 0/0。实际入口动作已执行：

- 通过主导航打开“同步设置”。
- 点击“开始整理”并等待 synthetic status 响应。
- 打开 accepted Skill 与 pending note 详情。
- 切换“资源索引”并检查 confirmed Skill 的全部安全动作。
- 在 desktop 和 mobile 上以键盘触发导航、开始整理、打开/关闭详情。
- 从 `batch-aborted` 状态再次触发整理；current 成果保留，恢复入口可用。精确 skip/retry 数量由 organization/Python contracts 复核。

## Destructive flows

生产 UI diff 中没有 destructive component。migration 验证只在临时 synthetic roots 中运行：

- dry-run 默认不写 live/backup/public。
- apply 的 fresh plan ID / explicit confirmation / concurrent-plan rejection 均通过测试。
- journal fault 与 restart recovery 恢复完整旧代或新代。
- 未对真实 `.xhs-favorites/` 运行 `--apply`。

## Bugs

### QA-001 — confirmed Skill 页面缺少完整核验元数据

- 严重度：MEDIUM
- 状态：verified
- 复现：打开 synthetic success 的 accepted Skill 详情；修复前无法同时核对 manifest、核验日期、stars、compatibility 以及 repo、ZIP、文档动作。
- 根因：QA fixture 只提供部分属性；真实 public builder 只映射领域通用 `resource_index.fields`，而 software profile 的资源集合混合 Skill 与非 Skill，无法用全局字段表达 type-specific contract。首次修复后的回归又误走了通用资源索引入口，且 mobile 属性行被宽泛的后代选择器挤叠。
- 修复：用 domain profile 的 `resource_index.fields_by_type` 数据驱动字段映射，accepted-note 详情通用渲染 `resource.attributes`；fixture 同步提供 stars、manifest、核验日期、compatibility；回归直接走 accepted Skill 的“查看总结”，同时断言 repo、ZIP、文档和 mobile 几何无重叠。
- RED 1：focused desktop/mobile → 0/2，缺 `Skill manifest`。
- RED 2：改为真实 accepted-note 详情入口后 → 0/2，缺 `许可证`。
- RED 3：加入相邻属性 bounding-box 断言后 → desktop PASS、mobile FAIL（前一行 bottom `683.0625` 大于后一行 top `659.875`）。
- GREEN：同一 focused E2E → 2/2 PASS。
- 提交：`84cc434 fix(qa): QA-001 — expose confirmed Skill metadata`、`d14de43 fix(qa): QA-001 — verify accepted Skill detail`、`911baef fix(qa): QA-001 — prevent metadata overlap`
- 回归：`test:site` 112/112、`test:knowledge` 2/2、最终 E2E 32/32、`release:check` exit 0。

### QA-002 — type-specific 字段配置缺少 fail-closed 校验

- 严重度：MEDIUM
- 状态：verified
- 复现：独立复审发现 `fields_by_type: "Agent Skill"` 或 `{ "Agent Skill": [{}] }` 可通过 `validateResourceIndex`，构建成功但正式 Skill 元数据可静默消失。
- 根因：新增的 data-driven `fields_by_type` 在使用前没有纳入 resource-index schema validation。
- 修复：要求 `fields_by_type` 为 plain object；每个 type 对应数组；每个 descriptor 是包含非空 `field` 与 `label` 的 plain object。
- RED：目标 Node test → 0/1，`Missing expected exception`。
- GREEN：同一目标 test → 1/1 PASS；随后 project lint、site 112/112、focused E2E 2/2 PASS。
- 提交：`645e6b2 fix(qa): QA-002 — validate typed metadata fields`
- 回归：最终 `release:check` exit 0；独立 JavaScript 复审无剩余发现。

## VC-QA-01..15 result matrix

| ID | Result | Entry → Action → observed result / evidence |
|---|---|---|
| VC-QA-01 | PASS | Workbench → 同步设置 → 开始整理；core saved，confirmed Skill 和完整动作可用，terminal copy 为 published/unchanged truth，不产生第二版成功声明。 |
| VC-QA-02 | PASS | `summary-failed` / `batch-aborted` → 打开第二张卡；attempted failure 与 not-attempted 文案分离，已成功卡保留。E2E 两项目均通过。 |
| VC-QA-03 | PASS | `batch-aborted` → 再次触发；恢复入口存在，current 结果保留。organization/Python contracts 验证 current skip 与计数不重复。 |
| VC-QA-04 | PASS | `safety-stopped` → 开始整理；立即显示安全停止、人工验证与“检查后重试”，E2E 不出现发布成功。 |
| VC-QA-05 | PASS | pending note → 打开详情；显示安全 metadata fallback 与“总结已捕获，等待审核”，不冒充 accepted 总结。 |
| VC-QA-06 | PASS | 同一 pending note 分别从 manager/public 打开；manager 显示白名单 overlay，public 不挂载也不请求私有 overlay。 |
| VC-QA-07 | PASS | confirmed Skill → accepted note“查看总结”；显示 identity、repo、ZIP、license、manifest、date、stars、compatibility、文档动作。QA-001 回归 desktop/mobile 2/2。 |
| VC-QA-08 | PASS | pending Skill candidate → 打开详情；保持 Other/candidate pending 语义，无 guessed GitHub action；formal-output negative test 通过。 |
| VC-QA-09 | PASS | `build-failed` → 开始整理；显示旧快照保留、无 publish/full-success 声明；snapshot rollback contracts 通过。 |
| VC-QA-10 | PASS | `publish-failed` → 开始整理；显示 local build 保留、remote held previous；desktop/mobile copy 清楚。 |
| VC-QA-11 | PASS | `stale` → 打开详情；正文变化明确要求重新审核；revision contract 覆盖 evidence-only 变化不重抓正文总结。 |
| VC-QA-12 | PASS | synthetic legacy state → migration tests；17/17 验证 count-only dry-run、conservation、fresh confirmation、fault rollback/restart recovery。 |
| VC-QA-13 | PASS | keyboard-only 导航、run panel、详情、repo/ZIP/close；focus、target、native dialog return 在两个 Playwright 项目通过。 |
| VC-QA-14 | PASS | 人工检查 1440×1000 与 375×844；status、overlay、多动作无重叠或隐藏，body `scrollWidth == clientWidth`。 |
| VC-QA-15 | PASS | 人工比较 success / summary-failed / batch-aborted / stale / build-failed / publish-failed / safety-stopped；无需读日志即可区分核心已保存、已尝试失败、未尝试、等待审核及 build/publish failure。 |

## Manual visual evidence

- `evidence/success-manager-desktop.png`
- `evidence/success-manager-mobile.png`
- `evidence/success-public-desktop.png`
- `evidence/success-public-mobile.png`
- `evidence/skill-detail-desktop.png`
- `evidence/skill-detail-mobile.png`
- `evidence/publish-failed-desktop.png`
- `evidence/publish-failed-mobile.png`

人工检查结论：

- 375×844 上没有水平溢出；confirmed Skill 的 repo、ZIP、文档三个动作均可见。
- mobile 资源属性标签会按列宽换行，但不重叠、不截断值、不隐藏动作。
- publish failure 的“远端上一版 / 本地结果保留”同时可见；不会被 toast 或导航遮挡。
- desktop 与 mobile 的状态卡、详情和 live status 均保持可读。

## State coverage — regression walk

全部修复提交后重新运行 32 个 desktop/mobile Playwright journeys，并重新截取 confirmed Skill desktop/mobile 页面。独立 JavaScript reviewer 最终复审：CRITICAL=0 HIGH=0 MEDIUM=0 LOW=0。

_No regressions found._

## Command evidence

| Command | Exit | Evidence |
|---|---:|---|
| `npm.cmd run test:e2e`（baseline） | 0 | 30/30 PASS |
| `npm.cmd run test:e2e -- site/e2e/qa-accepted-skill-metadata.regression-1.spec.mjs`（RED） | 1 | 0/2；缺 `Skill manifest` |
| accepted-detail focused E2E（RED） | 1 | 0/2；真实 note detail 缺 `许可证` |
| mobile geometry focused E2E（RED） | 1 | desktop 1 PASS / mobile 1 FAIL；属性行重叠 |
| 同一 focused E2E（GREEN） | 0 | 2/2 PASS |
| resource-index validation target（QA-002 RED） | 1 | 0/1；非法 `fields_by_type` 未抛错 |
| 同一 validation target（GREEN） | 0 | 1/1 PASS |
| `npm.cmd run lint:a11y` | 0 | ESLint PASS |
| `npm.cmd run test:site` | 0 | 112/112 PASS |
| `npm.cmd run test:knowledge` | 0 | knowledge script PASS + formal output 2/2 |
| `node --test --test-name-pattern="migration" skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` | 0 | 17/17 PASS |
| `npm.cmd run release:check` | 0 | syntax 64；site 112；publish 15 pass/1 documented Windows symlink skip；knowledge 2；curation 27；skill-sync 10；release-contracts 7；lifecycle 13；organization Python 11 + Node 39；Python 230 + DianDian 29；E2E 32；privacy verify PASS |

一次误用 Python dotted unittest class 名称产生 loader error；随后核对该文件没有 migration test，相关 migration contract 由上述 Node 17/17 目标测试与完整 release gate 覆盖。该 runner 输入错误不是产品失败。

独立 reviewer 运行 `eslint .` 时触及被 Git 忽略的私有 `.xhs-favorites/browser-profile` 第三方树并产生 scope noise；该命令不是项目 lint 入口。项目定义的 `npm.cmd run lint:a11y` 仅检查 `site/app.js`、`site/local-bridge-utils.mjs`、`site/resource-utils.mjs`，最终 exit 0。

## Privacy and safety observations

- 仅出现 synthetic stable IDs 与 `https://github.com/owner/repo` 固定测试 URL。
- 未读取或输出 Cookie、`xsec_token`、bridge token、个人主页、收藏夹 ID、原始视频、帧、完整 OCR 或真实评论。
- 未访问小红书、GitHub API 或其他平台 host；浏览器只连接 `127.0.0.1:8766/8767`。
- 未运行真实迁移 apply；未 push、创建 PR、merge 或 deploy。

## Final assessment

- Bugs found: 2
- Verified fixes: 2
- Best-effort/reverted/deferred: 0/0/0
- Baseline → final browser suite: 30/30 → 32/32
- Health score: 92 → 100
- Step 6 code gate: PASS

Completeness: 10/10  Confidence: 10/10

<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "qa",
  "step": 6,
  "phase": null,
  "severity": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0
  },
  "completeness": 10,
  "confidence": 10,
  "state_coverage": {
    "visited": 9,
    "total": 9,
    "skipped": []
  },
  "triggers_exercised": [],
  "callsites_walked": [],
  "oos_citations": [],
  "findings": []
}
-->
