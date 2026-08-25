# FavSense 收藏整理端到端恢复 Brief

## Headline

端到端收藏整理闭环已在 synthetic 数据上通过 CODE、REVIEW、QA 与 COVERAGE-FILL：缺失总结现在显示真实状态，accepted Skill 展示已核验 GitHub 仓库、ZIP、manifest、兼容性与安全动作；当前仅需人工审阅本 Brief，尚未也不得自动进入真实迁移或 PR/发布流程。

分支：`codex/favsense-organization-recovery`

Step 4 base：`fc0a22094dcbb1c41e99e333449ab5293baa5421`

批准 Spec：[2026-08-22-favsense-end-to-end-organization-recovery-spec.md](../../specs/2026-08-22-favsense-end-to-end-organization-recovery-spec.md)

批准 Plan：[2026-08-22-favsense-end-to-end-organization-recovery-plan.md](../../plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md)

验证清单：[2026-08-22-favsense-end-to-end-organization-recovery-verification-checklist.md](../../specs/2026-08-22-favsense-end-to-end-organization-recovery-verification-checklist.md)

安全事实：本流水线仅使用 synthetic fixtures 和 loopback 服务；没有读取真实平台或私有收藏数据，没有对真实 `.xhs-favorites/` 执行 migration apply，也没有 push、创建 PR、merge、deploy 或远端发布。

## Verification checklist run table

| Gate / checklist slice | Pass | Fail | Brain-Hands resolved | Residual actionable | Evidence |
|---|---:|---:|---:|---:|---|
| Step 4 Task completion inventory | 12 | 0 | 12 | 0 | Task 0–11 均有原子提交；CODE report |
| Step 4 mounted desktop/mobile user walk | 8 | 0 | 0 | 0 | CODE report 的批准本机 Playwright 8/8 |
| Step 5 Fix-First review | 1 | 0 | 28 | 0 | Review audit；最终 CRITICAL/HIGH/MEDIUM 为 0 |
| Step 6 `VC-QA-01..15` | 15 | 0 | 2 | 0 | QA-001、QA-002 均 RED → GREEN |
| Step 7 applicable layers / approved states | 6 / 9 | 0 / 0 | 1 | 0 | fixture reset boundary RED 0/2 → GREEN 2/2 |
| Step 7 final desktop/mobile Playwright | 34 | 0 | — | 0 | Chromium 17 + mobile Chromium 17 |
| Step 7 focused post-gate user walk | 24 | 0 | — | 0 | audit log；真实挂载的 synthetic journeys |

最终人工复核项只有 2 条，并且都不是功能兜底：

1. `VC-QA-14` — `manual-only: visual-polish`：复看 desktop/mobile 的排版、换行和视觉密度；必需动作存在、无溢出和 44px target 已由 Playwright 自动化。
2. `VC-QA-15` — `manual-only: subjective-ux`：判断成功、失败、未尝试、等待审核与恢复文案是否足够直观；每个状态及其精确文案已由 Playwright 自动化。

所有用户可见功能行为均有真实 Playwright 覆盖：

| Checklist | Automated behavior | Real Playwright test |
|---|---|---|
| `VC-QA-01` | 一键整理、running 轮询、终态按钮与成功/unchanged 语义 | `site/e2e/organization-recovery.spec.mjs` — `running phases keep polling until the terminal organization state` |
| `VC-QA-02/03` | attempted failure、batch-aborted 与恢复入口分别可见 | 同文件 — `summary-failed exposes its distinct note recovery state`、`batch-aborted exposes its distinct note recovery state` |
| `VC-QA-04` | safety stop 不冒充成功 | 同文件 — `safety-stopped remains a truthful terminal run state` |
| `VC-QA-05/06` | 本机 pending overlay 可见，public origin 不挂载也不请求 | 同文件 — `local note detail shows captured summary as pending review without publishing it`、`public origin never mounts or requests the private pending overlay` |
| `VC-QA-07` | confirmed Skill 显示 repo、ZIP、license、manifest、日期、stars、兼容性和 docs action | `site/e2e/qa-accepted-skill-metadata.regression-1.spec.mjs` — `confirmed Skill fixture exposes the complete review metadata` |
| `VC-QA-08` | 未核验 Skill 不获得猜测链接或正式输出 | `site/e2e/organization-recovery.spec.mjs` 的 pending detail journey；formal-output negative contracts |
| `VC-QA-09/10` | build/publish failure 保留上一版且不声称完整成功 | 同文件 — `build and publish failure transitions never claim full completion`、`publish-failed remains a truthful terminal run state` |
| `VC-QA-11` | stale 明确要求重新审核 | 同文件 — `stale exposes its distinct note recovery state` |
| `VC-QA-12` | migration dry-run、守恒、fresh confirm、journal rollback | Node migration contracts 17/17；无真实 apply 或用户界面写入 |
| `VC-QA-13` | 键盘遍历视图、启动、详情关闭与焦点恢复 | `site/e2e/design-keyboard-flow-regression.spec.mjs` 的两个 keyboard tests |
| `VC-QA-14` | desktop/mobile 必需控件、44px target、无 metadata 重叠 | `site/e2e/design-target-size-regression.spec.mjs` 与 accepted-Skill metadata regression |
| `VC-QA-15` | 各终态精确文案在真实挂载中可区分 | `site/e2e/organization-recovery.spec.mjs` 的 recovery/terminal state 参数化 tests |

## Plan task completion

Step 4 入口盘点为 done 12、partial 0、missing 0、orphan 0。Stage B 完成 Task 0–11；没有 confirmed-deferred 任务，没有 `.todo()`/`test.todo()`，也没有未分配的 Spec、BUG、UX 或 AC。

| Task | Result | Commit |
|---|---|---|
| 0 生命周期证据 | done | `1962947` |
| 1 RED 回归基线 | done | `de9bf48` |
| 2 内容/证据 revision 绑定 | done | `8bc8df4` |
| 3 真实正交状态 | done | `bfdd76b` |
| 4 单一最终快照事务 | done | `a387e29` |
| 5 确定性 curation pipeline | done | `fb2e813` |
| 6 安全 fallback/resume | done | `45c095f` |
| 7 已核验 Skill resource | done | `d17777d` |
| 8 完整资源动作/pending overlay | done | `efc7ac6` |
| 9 统一 formal outputs | done | `6effc20` |
| 10 可恢复 migration | done | `805678d` |
| 11 文档与 pre-review 验证 | done | `1544825` |

### BUG-01..16 closure

| BUG | Fix owner / commit | RED → GREEN evidence |
|---|---|---|
| BUG-01 | Tasks 5/9 — `fb2e813`, `6effc20` | 缺失生产 curation 编排 → accepted/hash/resource gate 与 formal output 通过 |
| BUG-02 | Task 5 — `fb2e813` | 无 candidate producer → deterministic candidate pipeline 通过 |
| BUG-03 | Tasks 5/9 — `fb2e813`, `6effc20` | builder 信任分裂 → KB/public 共用唯一 trust decision |
| BUG-04 | Task 7 — `d17777d` | keyword 可误升格 Skill → 未核验项只保留 candidate |
| BUG-05 | Task 7 — `d17777d` | 名称猜 repo → stable resource ID + canonical repo verification |
| BUG-06 | Task 8 — `efc7ac6` | detail 只显示一个动作 → repo、ZIP、docs 全部渲染 |
| BUG-07 | Tasks 3/6 — `bfdd76b`, `45c095f` | failed/未尝试混淆 → failed 与 batch_aborted 分离 |
| BUG-08 | Task 6 — `45c095f` | 无安全 fallback → cached-only evidence 与 stop contract 通过 |
| BUG-09 | Task 4 — `a387e29` | early publish → final gate 前 0、之后最多 1 |
| BUG-10 | Tasks 3/4 — `bfdd76b`, `a387e29` | finalizer failure 仍像完成 → truthful failed state |
| BUG-11 | Tasks 3/4 — `bfdd76b`, `a387e29` | publish failure 状态失真 → remote-held-previous 可见 |
| BUG-12 | Task 9 — `6effc20` | KB/public 语义漂移 → identical accepted/current gate |
| BUG-13 | Tasks 3/8 — `bfdd76b`, `efc7ac6` | 统一“当前未展示点点总结” → captured、failed、aborted、stale、pending 精确显示 |
| BUG-14 | Task 7 — `d17777d` | 不完整/过期资源可通过 → manifest/date/license/compatibility freshness gate |
| BUG-15 | Tasks 0/11 — `1962947`, `1544825` | 用户结果不在 release gate → Node/Python/Playwright/release gates 通过 |
| BUG-16 | Task 7 — `d17777d` | fallback kind 旧断言 → `candidateKind` contract 通过 |

### UX-01..14 and AC-01..15 closure

| IDs | Status and evidence |
|---|---|
| `UX-01` | PASS — manager 的“开始整理”真实入口；running Playwright test |
| `UX-02` | PASS — phase progress/terminal state 由 organization recovery Playwright 覆盖 |
| `UX-03` | PASS — captured pending summary 由 local-overlay Playwright test 覆盖 |
| `UX-04` | PASS — failed 与 batch-aborted 两个参数化 Playwright tests |
| `UX-05` | PASS — authenticated local overlay 与 public isolation 两个 Playwright tests |
| `UX-06` | PASS — pending/failed/stale 精确安全文案 Playwright coverage |
| `UX-07` | PASS — accepted/current summary 与 evidence contracts；真实 detail mount |
| `UX-08` | PASS — candidate 不冒充 confirmed Skill；formal-output negative matrix |
| `UX-09` | PASS — repo/ZIP/docs actions 与完整 metadata regression |
| `UX-10` | PASS — build failure Playwright test |
| `UX-11` | PASS — publish failure Playwright test |
| `UX-12` | PASS — resume/current skip Python contracts + batch-aborted mounted journey |
| `UX-13` | PASS — safety-stopped mounted journey |
| `UX-14` | PASS — stale mounted journey + revision contracts |
| `AC-01` | PASS — point v2 atomic save feeds candidate/audit/build or honest pending |
| `AC-02` | PASS — accepted/current formal-output gate |
| `AC-03` | PASS — local overlay/public isolation Playwright tests |
| `AC-04` | PASS — each public Skill has exactly one verified resource |
| `AC-05` | PASS — repo/ZIP/license/manifest/date/compatibility regression |
| `AC-06` | PASS — all safe actions in real detail mount |
| `AC-07` | PASS — failed/batch-aborted Playwright tests |
| `AC-08` | PASS — resume/current-skip Python contracts |
| `AC-09` | PASS — snapshot/publisher contracts prove 0 early and at most 1 final publish |
| `AC-10` | PASS — build/publish failure never claims full success |
| `AC-11` | PASS — dual-output rollback and remote-held-previous contracts |
| `AC-12` | PASS — safety-stopped Playwright + no-retry contracts |
| `AC-13` | PASS — `npm.cmd run verify` public/privacy tree gate |
| `AC-14` | PASS — synthetic migration conservation/fresh-confirm/journal tests |
| `AC-15` | PASS — core/candidate pipeline tests run with no model service |

Rollback remains explicit: code uses atomic commits; curation and KB/public snapshots recover one complete old or new generation from journals; build failure preserves the old local pair; publish failure keeps the new local pair while remote remains on the previous version; migration defaults to dry-run and guarded apply requires a fresh matching confirmation.

## Step 5 findings table

| Phase | Before CRITICAL / HIGH | After CRITICAL / HIGH | Remediation | Residual |
|---|---|---|---|---|
| Phase 1 `/review` | Source report records 28 actionable findings but does not preserve a trustworthy initial severity split | 0 / 0 | 28 Fix-First findings resolved; final JavaScript, Python and security reviews PASS | 5 LOW |
| Phase 2 `/design-review` | 0 / 3 | 0 / 0 | 6 findings fixed: metadata, targets, keyboard focus, focus contrast, focus restoration, page metadata | 1 LOW observation; Design A, AI Slop A |
| Phase 3 mockup parity | 0 / 0 | 0 / 0 | Correctly skipped: approved Plan has no mockups, pipeline index has `mockup_files: []`, no `data-mockup-state` exists | none |

没有 residual CRITICAL，因此不存在 residual CRITICAL cause。保留的 LOW 原因是：

- Phase 1 LOW-001：evidence attachment 对小规模 candidate/packet 做重复线性扫描。
- Phase 1 LOW-002：review merge 对小规模 candidate/review 做重复线性扫描。
- Phase 1 LOW-003：可选个人同步的 missing-file 判断仍依赖 SDK 错误文字。
- Phase 1 LOW-004：authenticated local overlay 使用 POST，而批准 Plan 文案写的是 GET。
- Phase 1 LOW-005：已认证 loopback overlay 对 invalid/unknown/unavailable 返回可区分的安全错误。
- Phase 2 OBS-001：public-origin 的可选 local bridge discovery 返回 404；不产生视觉或私有数据影响。

这些 LOW 均不影响已批准用户结果、数据完整性或当前 gate；如果数据规模、SDK API 或 overlay contract 后续变化，再以独立 Spec/Plan 处理，不在本 Brief 中扩 scope。

## Step 6 QA + Step 7 COVERAGE-FILL

| Stage | Bugs/gaps found | Fixed | Deferred | New source tests | Suite delta | Regressions |
|---|---:|---:|---:|---:|---:|---:|
| Step 6 QA | 2 MEDIUM | 2 | 0 | 1 Playwright regression + 1 Node schema test | 30/30 → 32/32 Playwright | 0 |
| Step 7 COVERAGE-FILL | 1 fixture-isolation gap | 1 | 0 | 1 Playwright source test | 32/32 → 34/34 Playwright | 0 |

Step 6 修复：

- QA-001 让 accepted Skill detail 完整展示 identity、GitHub repo、ZIP、license、`SKILL.md` manifest、核验日期、stars、compatibility 和 docs action，并修复 mobile metadata 重叠；focused desktop/mobile 由 0/2 转为 2/2。
- QA-002 为 `fields_by_type` 增加 fail-closed schema validation；目标 Node test 由 0/1 转为 1/1。

Step 7 修复：

- synthetic fixture 的 `/__test/reset` 原先未要求固定 test-control header；负向 Playwright 由 0/2 转为 2/2，并与 `/__test/scenario` 使用同一封闭边界。

最终命令证据（2026-08-25）：

| Command | Result |
|---|---|
| `npm.cmd run release:check` | exit 0；syntax 64、site 112、publisher 15 pass + 1 documented Windows symlink skip、formal 2、curation 27、Skill sync 10、release contracts 7、lifecycle 13、organization Python 11 + Node 39、Python 230 + DianDian 29、Playwright 34 |
| `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"` | exit 0；230/230 |
| `npm.cmd run verify` | exit 0；required files、privacy、ignore 与 tracked/public boundaries PASS |
| `npm.cmd run lint:a11y` | exit 0 |
| `npm.cmd run test:e2e` | exit 0；34/34，Chromium 17 + mobile Chromium 17 |
| `npm.cmd run test:organization`，连续两次 | 每次 Python 11/11 + Node 39/39 |
| Step 7 focused post-gate walk | 24/24 desktop/mobile journeys |

Deferred tests/stubs：0。Mockup parity Phase 3 正确跳过，因为仓库没有批准 mockup；这不是覆盖缺口。真实跨平台 PR CI 仍是 `not_yet_applicable`，只能在用户以后明确授权创建 PR 后执行，不能伪装成本次 pre-Brief 证据。

## Outstanding decisions for the human

None — every finding that required an obvious in-scope action was fixed and verified in this run. The remaining six LOW observations are documented limitations, not shipping decisions or hidden functional gaps.

当前人工审阅应确认的是证据与范围，而不是授权执行：真实私有数据迁移、真实平台访问、push、PR、merge、deploy 和远端发布全部仍未发生。

## Recommended next pipeline invocation

Recommended next action: human review of this Brief and the two explicitly categorized visual/subjective checks; do not invoke another pipeline stage yet. Any later `/ship`, PR creation, real migration apply, push, merge, deploy or remote publication requires separate explicit user authorization and must not be inferred from this Brief.

Completeness: 10/10  Confidence: 10/10
<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "patch-brief",
  "step": 8,
  "phase": null,
  "severity": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0
  },
  "completeness": 10,
  "confidence": 10
}
-->
