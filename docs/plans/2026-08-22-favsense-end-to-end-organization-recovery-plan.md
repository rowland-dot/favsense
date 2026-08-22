# FavSense 收藏整理端到端闭环与回归修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户主动触发的一键整理恢复为可验证的 `core → summary → evidence → candidate → resource → audit → build → publish` 闭环，使每条笔记和每个公开 Skill 都有真实状态、可信总结与可核验资源，并使失败、恢复、迁移和发布都可追溯且可回滚。

**Architecture:** 保留现有 loopback Bridge、SOP 扫描浏览器、确定性 Node 构建器和私有/公开目录边界。新增一套小而明确的运行状态契约、确定性候选/证据/资源/策展编排器，以及只在最终质量门后执行的单次构建发布门；Bridge 负责阶段顺序与原子运行状态，Node 模块负责可重复的数据契约和构建，前端只消费经过白名单验证的状态和本机 overlay。现有 curation 严格门不放宽，问题在上游补齐和下游真实展示。

**Tech Stack:** Python 3.12 `unittest`/本地 HTTP Bridge、Node.js 20 ESM/`node:test`、原生 HTML/CSS/JavaScript、Playwright Chromium、PowerShell、GitHub Actions。

**Governing Spec:** `docs/specs/2026-08-22-favsense-end-to-end-organization-recovery-spec.md`（APPROVED，v1.0）。

**Verification Checklist:** `docs/specs/2026-08-22-favsense-end-to-end-organization-recovery-verification-checklist.md`。

**Design inputs:** 本次批准范围没有 `docs/designs/*.html` mockup。UI 的结构与行为 source of truth 是 governing Spec 的 UX-01..UX-14 Entry → Action → Expected Result；视觉细节只按现有站点模式实现，并由 `VC-QA-14/15` 复核，不在计划中发明新信息架构。

---

## Scope and constraints

- [ ] 所有实现都在当前项目内完成；绝不修改 `/dev-pipeline` Skill、dev-methodology 规则或其安装副本。
- [ ] 采集继续只读；不读取、导出、打印或提交 Cookie、`xsec_token`、bridge token、个人主页、收藏夹 ID、原始视频、音频、图片帧或 OCR 全文。
- [ ] 平台输入、点点回复、评论、OCR 和外部网页始终按不可信内容处理，不能触发命令或改变流程。
- [ ] 验证码、访问频繁、`300031` 或其他安全信号第一次出现即停止，不切换通道绕过、不自动重试。
- [ ] 核心同步、候选生成和本地构建不依赖 Codex、Claude、Gemini 或其他模型；Agent 的唯一允许职责是编辑结构化 curation JSON，未配置 Agent 时流程仍须闭合。
- [ ] 不在本次流水线中读取或迁移真实私有数据；迁移只用合成夹具验证，真实 `--apply` 留给用户在 review brief 验收后显式触发。
- [ ] 不自动创建 PR、推送、合并或部署；`/dev-pipeline` 在 review brief 停止。

## Spec Coverage Pre-flight

Step 3 在任何方案评审前先冻结了 governing Spec 与验证清单。清点结果：Spec §3–§15、`BUG-01..16`、`UX-01..14`、`AC-01..15` 和验证清单的 176 个唯一稳定 ID 全部有实现 owner 与验证 owner；`UNASSIGNED=0`、`DEFERRED=0`、新增 `TODOS=0`。以下是 checklist family 的执行归属；清单中的 AC、BUG、Spec closure index 继续引用这里的原始 owner，不形成第二套需求。

| Checklist family | Implementation owner | Verification owner | Disposition |
|---|---|---|---|
| `VC-GOV-01..10` | Tasks 0, 11；Post-implementation Steps 5–8 | TP-001/011/014；Brief gate | ASSIGNED |
| `VC-SAFE-01..07` | Tasks 2–6, 8 | TP-003/008/009/011/013/017 | ASSIGNED |
| `VC-CORE-01..05` | Tasks 2, 4, 9 | TP-003/007/008/011 | ASSIGNED |
| `VC-SUM-01..05` | Tasks 2–4, 6 | TP-002/003/008/009 | ASSIGNED |
| `VC-EVD-01..07` | Tasks 5–6 | TP-004/009/011 | ASSIGNED |
| `VC-CUR-01..09` | Tasks 2, 4–5, 7, 9 | TP-003/004/005/007/008/016 | ASSIGNED |
| `VC-RES-01..08` | Tasks 5, 7–10 | TP-005/006/007/010/013 | ASSIGNED |
| `VC-OUT-01..05` | Tasks 8–9 | TP-006/007/008/011/013 | ASSIGNED |
| `VC-UI-01..06` | Tasks 3, 8 | TP-006/008/012/013/015 | ASSIGNED |
| `VC-BLD-01..08` | Tasks 4, 9 | TP-007/008/013 | ASSIGNED |
| `VC-STATE-01..05` | Tasks 2–4 | TP-002/003/008/013 | ASSIGNED |
| `VC-MIG-01..05` | Task 10 | TP-010/011/014 | ASSIGNED |
| `VC-AUTO-01..15` | Tasks 0–11 | TP-001..017；Steps 5–8 | ASSIGNED |
| `VC-QA-01..15` | Tasks 1–11；Step 6 QA | TP-013/015；QA report | ASSIGNED |
| `VC-AC-01..15`, `VC-BUG-01..16`, `VC-SPEC-03..15`, `VC-BRIEF-01..08` | Reuse the owner above and the detailed matrices below | Step 7 audit；Step 8 brief | ASSIGNED |

## What already exists and must be reused

| Existing mechanism | Evidence in current code | Plan treatment |
|---|---|---|
| Bounded child processes | `bridge-server.py::run_bounded_subprocess()` already caps time/output and owns Windows child jobs | Reuse for both new Node coordinators; replace formal-path bare `subprocess.run`, do not create a parallel runner |
| Loopback control boundary | Bridge already validates Host/Origin/token/body size; `site/local-bridge-utils.mjs` validates loopback session/config | Extend with v2 schemas and overlay projection; keep public origin unable to discover the bridge |
| Read-only and safety stop | Bridge/userscript tests already stop on safety signals and preserve the failed tab | Route every phase through the same terminal safety state; never add fallback/retry/publish after it |
| Stable IDs and incremental core | Current import path deduplicates stable note IDs and preserves prior successful catalog data | Add revision hashes and two-stage scope freezing without changing identity semantics |
| External point saver API 1 | Bundled Skill validates release/browser contract and exposes `save_record(destination, title, summary_text, note_id)` | Keep the signature; adapt only through private staging, validation, v2 augmentation and one atomic replace |
| Curation primitives | scope, review preparation, audit initialization, merge, validate and quality modules already exist | Refactor into a production orchestrator; preserve the strict accepted gate |
| KB transaction | `build-knowledge-base.mjs` already has staging/backup/live journal, lock and restart recovery | Generalize the primitive for the dual-output coordinator and migration rather than rewriting it |
| Public rollback | `build-public-site.mjs` writes same-directory atomically; tests preserve the prior public JSON on failure | Extract library-mode staging while retaining direct CLI compatibility |
| Publisher safety | `publish-huggingface.mjs` uses a temporary clone, public-tree validation and non-force push, and reports `unchanged` | Call it only after the shared build-version gate, at most once |
| Existing UI system | `site/index.html`, `site/styles.css` and `site/app.js` provide three-view IA, native dialog, tokens, breakpoints, focus styles and resource action components | Reuse the current IA and visual language; add state/overlay/action behavior, not a redesign |
| Release/privacy tests | Existing Node/Python/PowerShell suites, public-tree policy and release check are green | Preserve as adjacent regression gates and add the missing cross-component journeys |

## Reviewed target architecture

```text
UNTRUSTED PLATFORM / EXTERNAL CONTENT
  Xiaohongshu pages ──read-only──> SOP scan browser/userscript
  point reply / comments / OCR / GitHub response ──data only──┐
                                                              v
LOCAL PRIVATE TRUST BOUNDARY                            sanitize + validate
  Workbench ──one click──> Bridge single writer
                               │
                               ├─ freeze boards ──> seal stable note IDs
                               ├─ core catalog checkpoint + content revisions
                               ├─ point API 1 private atomic store
                               ├─ safe cached fallback ──> normalized evidence
                               ├─ candidate → audit → resource assessment → validate
                               │                         │
                               │                         └─ pending is honest, never accepted
                               └─ persistent finalizer CAS
                                      │
                                      v
                         snapshot coordinator + durable journal
                           ├─ stage/validate formal KB
                           ├─ stage/validate public JSON
                           └─ recover/swap both under one build_version
                                      │
                         0 publishes before gate; <=1 after gate
                                      v
                              publisher iff explicitly enabled and not local-only

LOCAL-ONLY SIDE CHANNEL
  authenticated loopback overlay ──sanitized per-note projection──> local detail
  public origin ──no descriptor, no request, no private DOM section──> static site

ANY SAFETY SIGNAL ──> safety_stopped ──X fallback ──X build ──X publish
```

The Python reducer is the authority for transitions. A versioned, public-safe status/reason registry is the shared contract consumed by Python, Node CLI validators and browser validation; cross-language contract tests reject version or enum drift. The system never claims a filesystem-wide atomic rename across the two outputs: consistency comes from a durable journal, idempotent recovery and a shared build version.

## Root-cause-aligned file map

### Lifecycle governance

- Create `scripts/verify-development-lifecycle.mjs` — 只在 pull-request 事件上校验 APPROVED Spec、Plan、TDD/Review/QA/Brief 证据链接和回滚说明。
- Create `scripts/test-verify-development-lifecycle.mjs` — 使用临时仓库事件夹具证明缺门失败、完整闭环通过。
- Create `scripts/check-syntax.mjs` and `scripts/test-check-syntax.mjs` — 从 `git ls-files` 获取公开跟踪的 `.js/.mjs`，逐文件运行当前 Node 的语法检查；不遍历任何私有/忽略目录。
- Create `scripts/run-organization-tests.mjs` and `scripts/test-run-organization-tests.mjs` — 用一个跨平台 Node 入口串行精确的 Python organization suite 和 Node organization contracts，保留子进程退出码。
- Modify `scripts/run-python-tests.mjs` and `scripts/test-run-python-tests.mjs` — 把已审查技术基线固定为 Python 3.12，避免文档、本地选择器和 CI 使用不同最低版本。
- Modify `.github/workflows/ci.yml` — PR 时运行生命周期门；push 仍运行现有 release gate。
- Modify `.github/PULL_REQUEST_TEMPLATE.md` — 固定 Spec/Plan/TDD/Review/QA/Brief/Rollback 字段。
- Modify `package.json` — 注册生命周期契约测试和 Playwright E2E 命令。
- Modify `scripts/verify-release.mjs` and `scripts/test-verify-release.mjs` — 把新增公共脚本/测试列入发布契约，但不让本地 release check 假装拥有 PR 事件正文。

### Core state and trust contracts

- Create `skills/xhs-favorites-organizer/scripts/organization_state.py` — Python 运行阶段、逐条状态、旧状态兼容映射、总体状态推导和安全投影的唯一来源。
- Create `site/organization-status-contract.json` — 公开安全、版本化的 phase/note 枚举、reason code、下一步动作与精确文案的唯一数据契约；Python、Node 和浏览器均读取这一文件，不复制三份常量。
- Create `skills/xhs-favorites-organizer/scripts/content-revision.mjs` — 分别规范化正文事实与评论/方法证据，计算互不混用的 `content_sha256` 和 `evidence_sha256`；Node 构建、候选和迁移共用。
- Create `skills/xhs-favorites-organizer/scripts/resource-quality.mjs` — 稳定 resource ID、GitHub URL、Skill 完整字段、过期策略和单资源不变量。
- Modify `skills/xhs-favorites-organizer/scripts/organize.mjs` — 写入稳定 `content_sha256`，正文变化保留旧记录但使下游状态 stale。
- Modify `skills/xhs-favorites-organizer/scripts/bridge-server.py` — 使用新状态模块；在点点记录中绑定正文哈希；暴露安全的运行状态与本机单篇 overlay。
- Modify `site/local-bridge-utils.mjs` — 严格校验 v2 运行状态、阶段计数、原因码和单篇 overlay；兼容旧状态只映射到允许的安全状态并附 `reason_code=unknown_legacy`。

### Deterministic organization pipeline

- Create `skills/xhs-favorites-organizer/scripts/generate-curation-candidates.mjs` — 从当前核心记录、领域规则和既有 accepted 记录的 revision-bound revalidation input 生成确定性候选骨架与 `candidate_seed_revision`；证据附着和资源评估完成后才封存最终 `candidate_revision`，没有足够事实时生成 blocker，不编造实体或摘要。
- Create `skills/xhs-favorites-organizer/scripts/normalize-evidence.mjs` — 将公开文字、匿名评论、点点、转写、图片 OCR 归一为同时绑定 `content_sha256` 与独立 `evidence_sha256` 的 evidence packet；每个方法记录清理后的 provider/tool version 与结果 hash，使回复或提取器版本变化能够使审核失效，但不泄露正文或路径。
- Create `skills/xhs-favorites-organizer/scripts/verify-github-resources.mjs`（Task 7）— 只验证证据中已明确出现的 canonical `owner/repo`；使用依赖注入的 `fetch`、单次请求、超时、无凭据、无搜索猜测，并通过 Task 5 的封闭 resource-assessment seam 返回精确的 identity/snapshot revisions。
- Create `skills/xhs-favorites-organizer/scripts/run-curation-pipeline.mjs` — 在 staging 中严格按 scope → initialize hash-bound audit placeholders → candidate seed → attach normalized evidence → closed resource assessment → seal final candidate revision → configured review（未配置时生成 pending）→ status-aware merge → validate 顺序运行，并把 candidates、resource assessments、audit、formal resources 与 curation 作为同一可恢复事务代交换。
- Modify `prepare-curation-review.mjs`, `initialize-curation-audit.mjs`, `merge-curation-results.mjs`, `validate-curation.mjs`, `curation-quality.mjs`, `curation-revision.mjs` — 使用相同正文/证据哈希、资源 ID、accepted 门和标准 reason code。
- Modify `bridge-server.py` — 最后一块核心数据只建立 checkpoint；最后一个本轮条目终态后调用一次 curation pipeline 和正式构建；仅当本轮配置显式启用发布且不是 `local_only` 时调用至多一次 publisher。

### Formal snapshot transaction

- Create `skills/xhs-favorites-organizer/scripts/journaled-transaction.mjs` — 从现有 KB journal 抽取有界、可恢复的同卷 named-participant 事务；只接受协调器给出的相对 child name 与固定 target/staging/backup，拒绝 symlink/reparse/path escape。
- Create `skills/xhs-favorites-organizer/scripts/build-organization-snapshot.mjs` — 在同一私有事务目录分别构建 KB 与 public 候选快照，二者全部验证成功后才以 journal 驱动交换；任一构建或交换失败都把两份 live 恢复到同一旧版本。
- Modify `build-knowledge-base.mjs` and `build-public-site.mjs` — 增加显式 library-mode staging target；单独 CLI 行为保持兼容，但 Bridge 正式 finalizer 只能调用双输出事务协调器。
- Create `skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs` — 对第二构建器失败、第一次交换后失败、重复 finalizer 和 build-version 一致性做 fault-injection 断言。

### Fallback, output, UI and migration

- Create `skills/xhs-favorites-organizer/scripts/extract-pending-image-text.py` — 对已经位于私有媒体缓存中的图片调用显式配置的本地 OCR 可执行文件；无引擎时精确返回 `ocr_unavailable`，不访问平台。
- Modify `download-pending-media.py`, `transcribe-pending-videos.py`, `run-video-analysis.ps1`, `prepare-curation-review.mjs` — 只在用户本轮范围、安全允许且工具可用时准备证据；视觉升级仍按缺失事实和预算停止。
- Modify `build-public-site.mjs` and `build-knowledge-base.mjs` — 共用 accepted/hash/resource 门；正式输出不直接消费 raw 点点；输出 `candidateKind`、精确 summary state、唯一 verified resource 和 build version。
- Modify `site/app.js`, `site/styles.css`, `site/index.html` — 分阶段进度、精确失败文案、本机待审核 overlay、全部安全资源动作、键盘/屏幕阅读器语义。
- Create `skills/xhs-favorites-organizer/scripts/migrate-organization-state.mjs` — 默认 dry-run，计数守恒、备份、`unknown_legacy`、stale 和回滚清单；真实 apply 需要显式确认值。
- Modify `skills/xhs-favorites-organizer/SKILL.md`, `references/automatic-workflow.md`, `references/curation-standard.md`, `references/organization-schema.md`, `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md` — 文档与实际单次最终发布、候选类型、overlay 和治理门一致；修改项目 Skill 时同步增加契约夹具。

## Target contracts

### Bridge ↔ Node subprocess boundary

Bridge 不直接猜测 Node 脚本的 stdout。`run-curation-pipeline.mjs` 和 `build-organization-snapshot.mjs` 都必须提供 CLI 包装层，只接受 Bridge 从受信配置和冻结运行状态组装的绝对路径参数；不接受平台文本、临时 URL 或自由命令。两个脚本的 stdout 都只允许一个 UTF-8 JSON 对象，stderr 只允许经清理的错误码/说明：

```json
{
  "schema_version": 1,
  "ok": true,
  "outcome": "ready_for_safe_build",
  "counts": { "accepted": 0, "pending": 0, "rejected": 0, "resource_pending": 0 }
}
```

```json
{
  "schema_version": 1,
  "ok": true,
  "outcome": "built",
  "build_version": "64-lower-hex",
  "counts": { "notes": 0, "categories": 0, "resources": 0 }
}
```

Bridge 通过现有 `run_bounded_subprocess()` 执行，对 command path、cwd、timeout、stdout/stderr 字节上限和环境变量做固定限制；然后使用严格白名单解析器 `parse_curation_pipeline_result()` / `parse_snapshot_build_result()` 验证精确 key set、枚举、整数边界和 hash。非 0 exit、超时、超限、多余 key、非法 JSON 或路径/私密值出现均 fail closed：curation 失败时不调用 snapshot，snapshot 失败时不调用 publisher。返回体永不包含文件路径、note/board 列表、原始证据或临时 URL。

### Point record v2 without changing external saver API 1

外部 `xhs-diandian-summarize-note` 的 `save_record(destination, title, summary_text, note_id)` API 1 保持不变。Bridge 从刚由 `organize.mjs` 原子写入的 catalog 重新读取目标 note 的正文专用 `content_sha256`；`prompt_version` 由已验证 `release.json` 版本与 `runtime/browser-contract.json` 内容 hash 组合得出，userscript/transport/API payload 都不得提供或覆盖这两个值。匿名评论、评论检查状态和其他证据方法不得进入 `content_sha256`，因此仅证据变化不会触发平台点点重抓；它们进入后述 `evidence_sha256` 并只使审核资格 stale。

Bridge 先让 API 1 saver 写入私有 transaction 目录中符合 `.xhs-favorites/diandian-summaries/<note-id>.json` 形状的 staging 目标，再验证清理后回复，组装包含 `version=2`、provider、prompt、prompt_version、content_sha256、request_sha256、summary_sha256 和 captured_at 的完整记录，最后一次原子替换 live 文件。`request_sha256` 只证明 API 1 请求/保存幂等；`summary_sha256` 必须由 staging 中清理后的已保存 `summary` 计算，并作为 `diandian_summary` 方法的 `result_sha256` 与 accepted audit 的回复正文绑定。任何 staging/扩充/验证/替换失败都不改变旧 live 字节，也不将 note 标记为 captured。旧 v1 记录仍可读，但只能映射为 `stale` + `reason_code=unknown_legacy`。

### Accepted restoration and revision lifecycle

Accepted 不能在 audit placeholder 初始化或 candidate seed 生成时恢复。当前一代必须先完成证据归一化和资源评估，再由 `sealCandidateRevision()` 对最终候选语义字段、`content_sha256`、`evidence_sha256`、稳定资源关联和 blocker 集合计算 `candidate_revision`；之后才允许构造 accepted passthrough review item。`candidate_seed_revision` 只用于证明骨架输入幂等，永远不能满足 accepted gate。

每条 accepted audit 必须保存并比较当前 `content_sha256`、`evidence_sha256`、最终 `candidate_revision`、`curation_revision` 和封闭的 `evidence_dependencies`。每个 dependency 精确包含 `{method, provider, version, result_sha256}`：点点使用 provider + `prompt_version` + 当前 `summary_sha256`；转写/OCR 使用本地工具/模型版本 + 清理后结果 hash；公开文字/评论检查由整体 `evidence_sha256` 绑定。provider、prompt/tool version 或结果 hash 任一变化都使审核 stale。点点 provider/prompt version 变化还必须使 summary stale 并重新纳入点点计划，即使正文 hash 未变；评论或其他非点点证据变化只使 curation stale，不重抓点点。

资源依赖是条件式的：没有工具/资源声明的普通 accepted 笔记不得因缺少 resource revision 被拒绝；需要资源的条目绑定稳定 resource ID 与 `resource_identity_sha256`。资源核验另有 `verification_snapshot_sha256` 和 UTC freshness 状态：stars、`verified_at` 或默认分支快照刷新且 identity 未变时，可以在同一流水线恢复原 accepted curation；canonical repo、license、manifest、compatibility 或其官方证据定位变化会改变 identity hash，使 curation stale 并等待重新审核。第 31 个 UTC 日历日开始，旧 snapshot 在刷新成功前不得满足 confirmed Skill 门。

### Exact user-visible status copy

| State/reason | Required visible copy |
|---|---|
| core complete while downstream is incomplete | `核心收藏已保存` |
| summary `not_started` | `尚未开始深度整理` |
| summary `captured`, curation pending | `总结已捕获，等待审核` |
| summary `failed` / `transport_failed` | `本篇总结失败，可在下次继续` |
| summary `batch_aborted` | `本次未尝试，可继续整理` |
| evidence `missing` | `证据不足，等待补齐` |
| summary/curation `stale` / `content_changed` | `正文已变化，等待重新审核` |
| curation `stale` / `evidence_changed` | `证据已变化，等待重新审核` |
| build `failed` | `构建失败，已保留上一版` |
| publish `failed` | `发布失败，远端仍为上一版；本地结果已保留` |
| publish `unchanged` | `内容无变化，无需发布` |
| any `safety_stopped` | `安全限制已触发，本轮已停止；请在 SOP 扫描浏览器完成验证后重新开始` |

完整成功文案仍只能在 Spec §6.2 六个条件全部成立时出现；前端不允许用 error string 自由拼接上述语义。

### Run-state v2

```json
{
  "schema_version": 2,
  "run_id": "safe-random-id",
  "state": "organization_partial",
  "build_version": "sha256-or-empty",
  "phases": {
    "core": { "status": "completed", "reason_code": "", "updated_at": "ISO-8601" },
    "summary": { "status": "batch_aborted", "reason_code": "transport_failed", "updated_at": "ISO-8601" },
    "evidence": { "status": "partial", "reason_code": "evidence_missing", "updated_at": "ISO-8601" },
    "curation": { "status": "pending_review", "reason_code": "audit_pending", "updated_at": "ISO-8601" },
    "build": { "status": "failed", "artifact_status": "held_previous", "reason_code": "build_failed", "updated_at": "ISO-8601" },
    "publish": { "status": "failed", "artifact_status": "held_previous", "reason_code": "publish_failed", "updated_at": "ISO-8601" }
  },
  "counts": {
    "scanned": 0,
    "new": 0,
    "summary_captured": 0,
    "summary_failed": 0,
    "summary_batch_aborted": 0,
    "curation_accepted": 0,
    "curation_pending": 0
  }
}
```

`derive_overall_state()` 只允许从阶段状态推导 `core_completed`、`organization_partial`、`organization_ready`、`published`、`completed_with_warnings`、`failed`、`safety_stopped`；旧 `completed` 读取为 `completed_with_warnings` 并附 `reason_code=unknown_legacy`，不得把 `unknown_legacy` 发明为总体状态或直接映射为完整成功。

### Phase-state v2

阶段状态使用以下封闭枚举，禁止调用者传入自由文本：

| Phase | Allowed `status` |
|---|---|
| `core` | `not_started`, `running`, `completed`, `failed`, `safety_stopped` |
| `summary` | `not_required`, `not_started`, `running`, `completed`, `partial`, `failed`, `batch_aborted`, `stale`, `safety_stopped` |
| `evidence` | `not_started`, `missing`, `partial`, `ready`, `blocked`, `safety_stopped` |
| `curation` | `not_started`, `running`, `pending_review`, `validated`, `failed`, `stale` |
| `build` | `not_started`, `running`, `succeeded`, `failed` |
| `publish` | `not_enabled`, `not_started`, `running`, `published`, `unchanged`, `failed` |

`summary`/`evidence` 的 `safety_stopped` 是运行阶段终止信号，不扩展 Spec §6.1 的逐笔枚举：当前真实尝试的 note 仍写该维度允许的 `failed` 和 `reason_code=safety_signal`，未尝试剩余项写 `batch_aborted`，而 run phase 记录全局停批。`build`/`publish` 失败时另设封闭字段 `artifact_status="held_previous"`，不把 `held_previous` 同时当成执行结果。总体状态按固定优先级推导：任一允许安全终止的阶段为 `safety_stopped` → `safety_stopped`；core 未产生可用结果或双输出事务失败 → `failed`；core 刚成功而下游仍全为 `not_started/not_required` → `core_completed`；下游已开始且存在 failed/batch_aborted/missing/pending/stale 等已报告非完整结果 → `organization_partial`（即使安全元数据快照已成功发布，也不覆盖为完整 `published`）；没有非完整项且同版本 KB/public 构建成功、publish 未启用 → `organization_ready`；没有非完整项且 publish 为 `published`/`unchanged` → `published`；没有非完整项、本地可用结果已保留但 publish 失败 → `completed_with_warnings`。完整成功文案还必须满足 Spec §6.2 的六个条件。

### Note-state v2

```json
{
  "schema_version": 2,
  "note_id": "stable-id",
  "content_sha256": "64-lower-hex",
  "evidence_sha256": "64-lower-hex-or-empty-before-evidence-normalization",
  "dimensions": {
    "core": { "status": "saved", "reason_code": "", "updated_at": "ISO-8601" },
    "summary": { "status": "captured", "reason_code": "", "updated_at": "ISO-8601" },
    "evidence": { "status": "missing", "reason_code": "evidence_missing", "updated_at": "ISO-8601" },
    "resource": { "status": "candidate", "reason_code": "resource_ambiguous", "updated_at": "ISO-8601" },
    "curation": { "status": "pending_review", "reason_code": "audit_pending", "updated_at": "ISO-8601" },
    "public": { "status": "not_eligible", "reason_code": "audit_pending", "updated_at": "ISO-8601" }
  }
}
```

每一维只接受 Spec §6.1 的枚举和该维度允许的 reason code。不得用一个共享 `reason_code` 覆盖并发事实：同一条笔记可以同时是 summary `failed/transport_failed`、evidence `missing/evidence_missing`、resource `candidate/resource_ambiguous`。UI 以 safety → build/publish → summary → evidence → resource/curation 的稳定优先级选择一个卡片短标签，在详情中同时列出所有非空维度；任何自由 error string 只能作为清理后的诊断补充，不能决定语义。`summary.status=failed` 仅用于真正尝试过的当前项；未尝试项必须是 `batch_aborted`。正文专用 `content_sha256` 变化时 summary/curation/resource 状态以 `content_changed` 进入 `stale`；正文未变而 `evidence_sha256` 变化时只使 evidence-dependent curation 以 `evidence_changed` 进入 `stale`，当前点点记录保持 captured 并在重跑中跳过。两种变化均保留历史 raw evidence。

### Empty, nil and already-current paths

| Condition | Required orchestration result | Build / publish behavior | Visible result |
|---|---|---|---|
| 0 requested boards | Reject before navigation with a typed validation reason | 0 / 0 | Explain that at least one available board is required |
| Requested board disappears before note seal | Run `failed`; never widen scope | 0 / 0 | Safe scope failure and retry guidance |
| Sealed note scope is empty | Resolve summary=`not_required`, evidence=`ready`, curation=`validated` with zero counts; never remain `awaiting_plan` | One idempotent safe snapshot only if current catalog output must be reconciled; publish obeys local-only/config and still <=1 | “没有需要整理的新内容” plus unchanged/build state |
| Every scoped note is current captured/accepted | Skip per-note work, validate current hashes/resources | One final version check; publisher returns `unchanged` only when remote content is identical | Skipped/current counts and “内容无变化，无需发布” |
| Every scoped note is pending/rejected | Curation returns `ready_for_safe_build` with zero accepted and exact pending/rejected counts | Build safe metadata fallbacks; never promote; publish <=1 only when explicitly enabled and not `local_only` | `organization_partial`, not full success |
| Publish disabled/local-only | All formal local stages can finish | Build once, publish 0 | `organization_ready` |
| Publisher reports identical content | Keep current local build and remote version | Publish attempt count <=1, status `unchanged` | `published` plus exact unchanged copy |

### Verified Skill resource

```json
{
  "id": "github-owner-repo",
  "name": "Official project name",
  "type": "Agent Skill",
  "canonical_repo": "owner/repo",
  "repo": "https://github.com/owner/repo",
  "download": "https://github.com/owner/repo/archive/refs/heads/main.zip",
  "license": "MIT",
  "skill_manifest": "path/to/SKILL.md",
  "verified_at": "YYYY-MM-DD",
  "stars_numeric": 123,
  "compatibility": ["Codex"],
  "compatibility_evidence": ["README.md"],
  "resource_identity_sha256": "64-lower-hex",
  "verification_snapshot_sha256": "64-lower-hex",
  "status": "verified"
}
```

`config/domain-profiles/software.json` 必须把 confirmed Skill 的核验有效期固定为 `resource_index.verification_max_age_days=30`。`resourceFreshness(resource, { today })` 只按注入的 UTC 日历日比较 `verified_at`：合法日期且 `0 <= today - verified_at <= 30` 天为 fresh；非法日期、未来日期或大于 30 天一律为 stale。在第 30 天边界仍 fresh，第 31 天 stale；构建器、验证器、迁移和测试必须共用此函数与配置值，禁止各自读取本地时区或另设默认值。

`resource_identity_sha256` 只覆盖 canonical repo、官方名称/类型、license、manifest、compatibility 和官方 compatibility evidence locator；`verification_snapshot_sha256` 覆盖 identity hash、API 确认的 default branch、派生 download、stars 与 `verified_at`。自动刷新只有在 identity hash 未变时才能沿用原 accepted curation；任何 identity 变化都必须进入 stale/review。Task 5 事务中的私有 `resource-assessments.json` 保存 verified/candidate/ambiguous/missing/stale 结果，公开且完整的 verified snapshot 才能写入正式 `references/software-resources.json`；两者必须与 candidates/audit/curation 同代提交。

公开 `kind="Skill"` 的条件是：accepted curation + 当前 `content_sha256` + 当前 `evidence_sha256` + 恰好一个 `status=verified` 的 resource ID + 完整资源字段。其他情况必须输出领域规则确定的安全 confirmed `kind`（没有匹配时为 `Other`）；仅当确定性候选分类器返回 `Skill` 但上述公开门未满足时，额外输出 `candidateKind="Skill"`，否则省略 `candidateKind`。任何分支都不输出猜测链接。

---

## Implementation tasks

### Task 0: Mechanical Spec → Plan → TDD → QA → PR gate

**Dependencies:** Approved Spec only. **Risk:** Medium — the gate must not make local development depend on GitHub PR metadata. **Outcome:** CI rejects lifecycle-incomplete behavior PRs while local release checks remain deterministic.

**Files:**
- Create: `scripts/verify-development-lifecycle.mjs`
- Create: `scripts/test-verify-development-lifecycle.mjs`
- Create: `scripts/check-syntax.mjs`
- Create: `scripts/test-check-syntax.mjs`
- Create: `scripts/run-organization-tests.mjs`
- Create: `scripts/test-run-organization-tests.mjs`
- Modify: `scripts/run-python-tests.mjs`
- Modify: `scripts/test-run-python-tests.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `package.json`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/test-verify-release.mjs`
- Modify: `CONTRIBUTING.md`

**Covers:** Spec §3.3 governance invariant, §10 Step 0, §14, §15 human/PR gates; `VC-GOV-*`, `AC-13`.

- [ ] **RED — write lifecycle and syntax contract tests.** Add lifecycle tests named `rejects_behavior_change_without_approved_spec`, `rejects_missing_plan_tdd_qa_or_brief_links`, `rejects_unchecked_rollback`, `rejects_external_or_traversing_evidence_links`, `accepts_preexisting_approved_spec_and_plan`, and `accepts_complete_pull_request_lifecycle`. Add syntax-runner tests proving it checks every tracked `.js/.mjs`, ignores untracked/private files, and returns the exact failing path/exit code. Temporary-repository fixtures contain only synthetic public artifacts; assertions compare exact gate IDs/paths, not generic truthiness.
- [ ] **RED — run the focused tests.** Run `node --test scripts/test-verify-development-lifecycle.mjs scripts/test-check-syntax.mjs`. Expected: FAIL because both production scripts do not exist.
- [ ] **GREEN — implement the PR-event verifier.** Export `verifyDevelopmentLifecycle({ root, event })`. Treat changes under production/config/UI/Skill paths as governed; resolve the PR body’s repository-relative Spec/Plan/Review/QA/Test outcome/Brief links inside the checkout, require the Spec to be APPROVED and the Plan to cite that exact Spec, and reject missing files, path traversal, external evidence URLs or mismatched slugs. The verifier explicitly accepts an approved Spec and Plan committed before the implementation PR; it does not require meaningless edits to either artifact. Require a non-empty RED/GREEN evidence reference inside the canonical brief and an explicit rollback statement. Do not inspect private directories or require PR metadata during local `npm.cmd run release:check`.
- [ ] **GREEN — wire CI, syntax and template.** Add `npm ci` before JavaScript checks and a `pull_request`-only lifecycle step after the release gate. Update the PR template with explicit `Spec`, `Plan`, `RED/GREEN evidence`, `Review`, `QA`, `Review brief`, `Rollback`, privacy, and human-approval checkboxes. Register `test:lifecycle` under `npm test` and `check:syntax` as `node scripts/check-syntax.mjs`; make CI and the final release gate invoke it.
- [ ] **GREEN — focused developer entrypoint.** Implement `scripts/run-organization-tests.mjs` to select the same Python 3.12 interpreter policy as the release runner, run only `test_organization_pipeline.py`, then run `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`; stop on the first non-zero child exit and propagate that exit without shell chaining. Register it as `test:organization`, cover order/exit propagation in `scripts/test-run-organization-tests.mjs`, document Windows `npm.cmd` versus POSIX/CI `npm` spelling, and keep `test:windows-contracts` out of non-Windows jobs. Update the existing Python selector/tests so local and CI both require Python 3.12 rather than the current `>=3.11` split baseline.
- [ ] **REFACTOR/VERIFY.** Run `node --test scripts/test-verify-development-lifecycle.mjs scripts/test-check-syntax.mjs scripts/test-verify-release.mjs`, `npm.cmd run check:syntax`, and `npm.cmd run verify`; expected all commands exit 0 and the existing privacy/public-tree gate remains intact.
- [ ] **COMMIT.** Stage only the files above and commit `chore: enforce development lifecycle evidence`.

### Task 1: Characterize the six broken end-to-end invariants before implementation

**Dependencies:** Task 0 test command registration. **Risk:** Medium — RED tests must fail for requirements, not brittle source text. **Outcome:** Every reported regression has a reproducible failing contract before production edits.

**Files:**
- Create: `skills/xhs-favorites-organizer/tests/test_organization_pipeline.py`
- Create: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`
- Create: `site/e2e/organization-recovery.spec.mjs`
- Create: `scripts/serve-qa-fixture.mjs`
- Create: `playwright.config.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`, `package-lock.json`

**Covers:** Spec §8–§9, §10 Step 1, BUG-01..BUG-16, AC-01/04/06/07/09/10/15.

- [ ] **RED — bridge lifecycle fixtures.** In `test_organization_pipeline.py`, add independent synthetic tests proving: current failure marks pending peers incorrectly; finalizer error can coexist with completed; core-last-board calls publish before summary plan; safety stop never calls fallback/publish; rerun must skip current-hash captured items.
- [ ] **RED — Node pipeline fixtures.** In `test_organization_contracts.mjs`, add fixtures proving: a saved point record has no production path to candidate/audit/build; fallback keyword can create `kind=Skill` without resource; KB and public builders disagree on raw point acceptance; confirmed Skill resource completeness is not enforced at the public projection.
- [ ] **SETUP — deterministic browser runner.** Run `npm.cmd install --save-dev @playwright/test` and `npx.cmd playwright install chromium`. In CI, add OS-specific Chromium installation after `npm ci` (`npx playwright install --with-deps chromium` on Ubuntu; `npx.cmd playwright install chromium` on Windows). Do not install or invoke a real platform browser profile.
- [ ] **RED — browser journey.** Create `serve-qa-fixture.mjs` and `npm.cmd run preview:qa-fixture` to serve the real `site/` plus a loopback-only synthetic Bridge whose data is fixed, contains no private values, performs no platform/network access and supports success/partial/failure states. Configure `chromium` plus `mobile-chromium` projects and register `test:e2e` plus `lint:a11y` package scripts under the release gate. `lint:a11y` runs the installed ESLint configuration over the authored browser JavaScript, but the plan does not treat JSX-only rules as proof for imperative `innerHTML`; mounted DOM and Playwright assertions own accessible names, live regions, focus and link behavior. Assert the rendered detail shows repo and ZIP, the run panel never claims full completion after build/publish failure, and local pending overlay is absent from public origin.
- [ ] **SETUP — fixture boundary.** The fixture owns an in-memory token and two loopback listeners: the real manager origin at `127.0.0.1:8766` and an ephemeral synthetic Bridge port. It serves `/.local/bridge.json` virtually rather than writing `site/.local/bridge.json`, never reads `.xhs-favorites/`, and fails the test on any request outside those listeners or any platform/GitHub hostname. The public-origin project receives no bridge descriptor; the local project exercises the real `localBridgeRequest()` path rather than a mocked DOM final state.
- [ ] **SETUP — fixture lifecycle and discovery.** Make Playwright `webServer` the sole automated owner with `workers=1`, `reuseExistingServer=false`, `/__health`, fail-fast 8766 conflict guidance and deterministic SIGINT/SIGTERM/test cleanup. `serve-qa-fixture.mjs --scenario success|partial|build-failed|publish-failed|safety-stopped` selects the manual/default initial scenario and emits one sanitized readiness JSON line; `--help` maps scenarios to UX/VC IDs. For the single Playwright-owned process, expose a fixture-only manager-origin `POST /__test/scenario` that accepts only the same closed scenario enum and `POST /__test/reset`; each test calls reset then selects its scenario before the real UI action. These endpoints exist only in `serve-qa-fixture.mjs`, require a fixed synthetic test header, never enter production Bridge/app code, and return no token/path. Manual mode prints only safe local/public URLs. Fixture schemas/IDs/times are deterministic, and CI failure artifacts are synthetic-only `test-results/`/`playwright-report/` with short retention and private-root exclusions.
- [ ] **RED — execute and record exact failures.** Run `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`, `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`, `npm.cmd run test:site`, and `npm.cmd run test:e2e`. Expected: each new target invariant fails for the documented current behavior while existing release/privacy tests remain green. Store RED evidence through `/dev-pipeline`; do not weaken assertions or mark tests todo.
- [ ] **GREEN ownership handoff — no product edit in this characterization task.** Record the exact downstream GREEN owner beside each failing assertion: revision/currentness → Task 2; status/copy → Task 3; build/publish order and rollback → Task 4; candidate chain → Task 5; fallback/resume → Task 6; Skill resource invariant → Task 7; overlay/actions → Task 8; cross-builder trust → Task 9. Task 1 is not considered green on its own; Task 11 must rerun the unchanged assertions after all named owners land.
- [ ] **COMMIT — preserve the RED checkpoint.** Commit only the new test harness/fixtures as `test: capture organization recovery regressions`. The branch is intentionally red at this intermediate TDD commit; Tasks 2–9 turn the same assertions green before any handoff.
- [ ] **RED checkpoint guard.** The intentionally red commit is evidence only: it must never be a PR head, release candidate or QA input. Branch-level release/lifecycle gates become eligible again only after Tasks 2–9 make the unchanged assertions green; Step 8 records both commit identities.

### Task 2: Bind summaries and acceptance to the current content revision

**Dependencies:** Task 1 RED fixtures. **Risk:** High — a wrong hash boundary can invalidate good work or accept stale evidence. **Outcome:** point eligibility is tied to current canonical body content, while audit eligibility is independently tied to current canonical body and evidence revisions.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/content-revision.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/organize.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `skills/xhs-favorites-organizer/scripts/curation-revision.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/curation-quality.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_bridge.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_pipeline.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`

**Covers:** Spec §3.3 version consistency, §4, §5.3–§5.4, §6.1 stale, UX-03/12/14, BUG-01/12, AC-02/08.

- [ ] **RED.** Add `content_revision_changes_only_when_body_facts_change`, `comment_change_updates_evidence_not_content_revision`, `saved_summary_requires_current_content_sha256`, `saved_summary_binds_clean_reply_sha256`, `summary_payload_cannot_supply_revision_metadata`, `point_v2_rejects_traversal_and_reparse_targets`, `point_v2_commit_failure_preserves_previous_bytes`, `changed_content_marks_old_summary_and_audit_stale`, `changed_evidence_stales_audit_but_skips_point_recapture`, `prompt_or_provider_change_stales_summary_and_audit`, `accepted_restore_waits_for_final_candidate_revision`, `non_resource_acceptance_does_not_require_resource_hash`, and `rerun_skips_current_hash_capture`. Assert complete transitions for body change, evidence-only change, point prompt/provider change, point reply overwrite and accepted restoration after final candidate sealing; assert external saver API 1 remains unchanged.
- [ ] **Run RED.** Run `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` and `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`; expected targeted failures for missing dual-revision boundaries and their distinct stale/resume transitions.
- [ ] **GREEN — canonical revisions.** Implement `contentRevision(note)` only over Unicode NFC-normalized title, description, tags and media type; trim/collapse whitespace and exclude comments/check state, author/account IDs, source-board IDs, timestamps, URLs, counters, likes and source encounter order. Implement `evidenceRevision({ contentSha256, comments, commentsChecked, methods })` over that content hash plus normalized evidence facts: drop empty comments, normalize the checked boolean, deduplicate comments by normalized text hash, sort by that hash, apply the existing bounded comment count after deterministic ordering, and sort bounded normalized method records by `(method, provider, version, result_sha256)`. Reject missing/extra method keys and invalid result hashes instead of omitting them. `organize.mjs` computes/stores the body hash once per sealed catalog revision; evidence normalization computes the evidence hash after actual methods are known. Add permutation/duplicate/Unicode/empty-value tests proving equivalent facts are stable, plus boundary tests proving comment/method/provenance changes update only `evidence_sha256` while a body change updates both.
- [ ] **GREEN — point record v2 adapter.** Keep the external Skill saver API 1 byte-for-byte compatible. After `organize.mjs` commits the catalog, Bridge reloads the target stable ID and obtains its trusted `content_sha256`; derive `prompt_version` from the already validated Skill release version plus browser-contract digest. Invoke the external saver only against a private transaction-shaped staging root, validate its v1 result, calculate `summary_sha256` from the cleaned persisted reply, wrap it into the plan’s point-record v2 envelope, and atomically replace the live note file once. Payload-supplied revision fields are rejected as unsupported. `request_sha256` remains only an API/save idempotency check and cannot satisfy curation acceptance. A failure before the final replace preserves the previous live bytes and leaves the note uncaptured; legacy live v1 maps to `stale` + `unknown_legacy`.
- [ ] **GREEN — point path boundary.** Validate `note_id` against the stable-ID grammar before deriving any filename; resolve destination beneath the private staging root and reject traversal, symlink/reparse targets or a payload-supplied destination. API 1 is permitted to write only the coordinator-owned staging target; validation/augmentation precedes the single live replace.
- [ ] **GREEN — acceptance gate.** Extend `hasCompleteAcceptedAudit()`/`isPublishableCuration()` with the conditional dependency contract above. Require current content/evidence/final-candidate/curation revisions and exact evidence dependencies; require point `content_sha256` + cleaned `summary_sha256` + provider/prompt version only when `diandian_summary` is actually an evidence method, and require resource ID/identity/fresh snapshot only when the candidate declares a resource. Preserve historical evidence and accepted curation data, but return false until the post-evidence/post-resource candidate is sealed and all applicable dependencies pass. A body mismatch invalidates point and audit; evidence-only mismatch leaves point captured; provider/prompt mismatch invalidates both point currentness and audit.
- [ ] **REFACTOR/VERIFY.** Run `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`, `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_bridge.py"`, `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`, and `python -m unittest discover -s ".\skills\xhs-diandian-summarize-note\tests" -p "test_save_summary.py"`; expected all commands exit 0, the external API 1 signature test remains green, and no private value appears in failure output.
- [ ] **COMMIT.** `feat: bind organization evidence to content revisions`.

### Task 3: Introduce orthogonal run/note states and truthful UI messages

**Dependencies:** Task 2 content revision. **Risk:** High — status semantics affect resume and user trust. **Outcome:** note/run phases have one validated reducer and the UI cannot infer full success from a legacy flag.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/organization_state.py`
- Create: `site/organization-status-contract.json`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `site/local-bridge-utils.mjs`
- Modify: `site/app.js`
- Modify: `site/styles.css`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_pipeline.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`
- Modify: `site/e2e/organization-recovery.spec.mjs`

**Covers:** Spec §5.10, §6, §7 UX-02/03/04/10/11/12/13/14, §12, BUG-07/10/11/13, AC-07/08/10/12.

- [ ] **RED — requested board scope.** Add `freezes_requested_board_scope_after_discovery_merge` and `fails_if_selected_board_becomes_unavailable`. Start with renamed/new boards and assert board IDs, mode, local-only target and configuration digest remain immutable for the run while a new run sees later configuration.
- [ ] **RED — state reducer.** Add tests for every allowed dimension, invalid enumeration rejection, safe reason-code whitelist, legacy `completed → unknown_legacy/completed_with_warnings`, and full run arcs. Assert that build or publish failure makes complete-success copy impossible.
- [ ] **RED — exact failure distinction.** Add a three-note plan test: first captured, second transport failure, third never attempted. Expected note statuses are `captured`, `failed`, `batch_aborted`; counts are 1/1/1.
- [ ] **RED — UI transition.** Extend existing mounted tests and Playwright to start in running, inject finalizer/build/publish failure, and assert the live region changes to the exact partial/failure message while retaining “核心收藏已保存”.
- [ ] **Run RED.** Run `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`, `npm.cmd run test:site`, and `npm.cmd run test:e2e`; expected failures at current single-state logic and generic source-metadata copy.
- [ ] **GREEN — state source of truth.** Implement constructors, per-dimension enum/reason validation, `transition_note_state()`, `transition_phase()`, `derive_overall_state()`, and `safe_public_projection()` in `organization_state.py`. Persist private per-note state under `.xhs-favorites/organization-state/` via staging + atomic replace; public run projection includes only safe counts/status/reason/build version. Make `site/organization-status-contract.json` the single public-safe registry for schemas, phase/note enums, reason codes, next actions and exact copy. Bridge resolves and reads that workspace-owned file at startup, Node validators read the same file, and the static browser fetches it from the same origin before accepting local status. No implementation is permitted to carry a handwritten duplicate enum/copy table. Python owns transitions while Node and browser consume/validate the registry; cross-language tests reject an unknown enum, missing reason, extra key, unreadable contract or version drift.
- [ ] **GREEN — requested board scope.** `trigger_manual_sync()` freezes the requested board IDs, mode, local-only target and configuration digest before navigation. Discovery merges names/new boards, but a selected board that disappears or is disabled fails the run rather than widening it. Task 4 seals the resulting note set before any downstream phase begins.
- [ ] **GREEN — Bridge adoption.** Replace manual arithmetic fields in `trigger_manual_sync`, `record_manual_result`, `update_diandian_progress`, `halt_diandian_cdp_run`, `complete_manual_after_diandian`, and `manual_sync_status` with the new transitions. Current attempted item gets `failed`; remaining plan items get `batch_aborted`; safety maps to `safety_stopped` and suppresses fallback/retry.
- [ ] **GREEN — strict frontend contract.** Extend `validateLocalBridgeSyncStatus()` for schema v2 and nested phases/counts with exact key allowlists. Update `renderManualSync()` and refresh/reload logic so copy is derived from phases, not `state === completed`. Replace “当前未展示点点总结” with the exact contract labels, including “尚未开始深度整理”, “总结已捕获，等待审核”, “本次未尝试”, “证据不足”, “正文已变化，等待重新审核” and “证据已变化，等待重新审核”.
- [ ] **REFACTOR/VERIFY.** Test every transition arc and run `npm.cmd run lint:a11y`; expected no a11y lint error and all behavior tests PASS.
- [ ] **COMMIT.** `feat: expose truthful organization phase states`.

### Task 4: Make final build and publish a single run-level transaction

**Dependencies:** Task 3 phase reducer. **Risk:** High — multi-board and thread races can double publish or strand a run. **Outcome:** zero pre-gate publishes and at most one final publish per build version through an injected, fail-closed curation-gate seam that Task 5 supplies in production.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/journaled-transaction.mjs`
- Create: `skills/xhs-favorites-organizer/scripts/build-organization-snapshot.mjs`
- Create: `skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `skills/xhs-favorites-organizer/scripts/build-knowledge-base.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/build-public-site.mjs`
- Modify: `skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template`
- Modify: `skills/xhs-favorites-organizer/test-fixtures/diandian-one-click-plan.json`
- Modify: `skills/xhs-favorites-organizer/tests/test_bridge.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_pipeline.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`

**Covers:** Spec §5.3/5.9, §6.2, UX-02/10/11, BUG-09/10/11, AC-09/10/11.

- [ ] **RED — ordering spy.** Use a fake two-board run and record calls. Assert zero formal build/publish before every summary plan reaches a terminal state; assert exactly one final build and at most one publish using the same `build_version`.
- [ ] **RED — note scope seal.** Have both selected boards submit stable IDs, seal their deduplicated union, then mutate board discovery and catalog before summary planning. Assert the sealed note IDs stay byte-identical, every downstream plan uses exactly that set, and notes appearing after the seal wait for the next run.
- [ ] **RED — rollback and restart paths.** Simulate KB/public builder failures, process termination at every snapshot journal boundary, Bridge restart after build/before publish, duplicate finalizer callbacks across restart and publisher failure. Assert both live snapshots recover to the same old or same new `build_version`, never a mixed generation; failed build never calls publisher; publish failure keeps the local build and sets `publish.status=failed`, `publish.artifact_status=held_previous`, `reason_code=publish_failed`.
- [ ] **RED — subprocess contract.** Feed Bridge a valid coordinator result, non-JSON, extra keys, oversized stdout/stderr, path/private-looking values, wrong hash length, timeout and non-zero exit. Assert only the exact safe envelope advances the run; all other cases set the typed build/curation failure and call neither the next coordinator nor publisher.
- [ ] **Run RED.** Run `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"` and `node --test skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs`; current `process_import()`/`publish_after_board()` ordering and independent builder swaps must fail.
- [ ] **GREEN — server-known plan and note seal.** At `trigger_manual_sync()`, freeze `summary_required` from validated server configuration and initialize `summary_plan_status=awaiting_plan` before any board completes. After all frozen boards submit their stable-ID sets, Bridge atomically seals their deduplicated union as `frozen_scope.note_ids`; the userscript is then permitted to submit only transient URL work for IDs in that set and no longer decides whether formal build/publication occurs. Summary/evidence/curation/finalization all read the sealed set. A missing/invalid/out-of-scope plan reaches an explicit failure/partial terminal state and cannot release the final gate.
- [ ] **GREEN — durable dual-output transaction.** Extract the current KB journal mechanics into `journaled-transaction.mjs` with explicit `prepare/replace/recover` operations over a closed ordered participant list; it validates coordinator-owned relative names and same-volume target/staging/backup locations and fsyncs the journal before every externally visible replace. Implement `buildOrganizationSnapshot()` so both builders write to sibling same-volume staging targets under one private transaction directory. Before either builder runs, compute `build_version` as the SHA-256 of one canonical preimage containing the sealed scope digest, complete curation-generation input digest, public-safe profile/config digest and both builder schema versions; the preimage excludes generated bytes, timestamps and every embedded `buildVersion` field. Pass that fixed version into both builders, then require both staged outputs to embed the exact value and pass schema/privacy checks. The coordinator uses the shared helper to persist participant-aware `prepared → backup(participant) → swap(participant) → committed` boundaries; every record contains validated transaction/build identities and coordinator-owned relative children. Bridge startup and every finalizer call `recoverSnapshotTransaction()` before doing work. Recovery is idempotent and yields both live outputs at the same old or new version before publication can proceed; ambiguous/symlink/reparse/path-escape state fails closed and preserves evidence privately. Task 5 and Task 10 must reuse this same helper rather than adding separate transaction engines.
- [ ] **GREEN — builder ownership seam.** Extract `buildKnowledgeBaseToStaging(options)` and `buildPublicSiteToStaging(options)` as library exports that create and validate staging artifacts but never swap a live target. `build-organization-snapshot.mjs` is the sole dual-output swap owner. Each builder’s existing direct CLI calls the same library export and then its existing single-output publish helper, preserving backward-compatible manual rebuild behavior without nesting a second transaction inside the coordinator.
- [ ] **GREEN — central finalizer.** Replace per-board `rebuild_knowledge_base()` + `publish_after_board()` completion with `maybe_finalize_organization(batch, curation_runner, snapshot_builder, publisher)`. Intermediate boards atomically save catalog/checkpoint and advance. The last board requires `curation_runner` to return `ready_for_safe_build` or `failed`; `ready_for_safe_build` includes a fully validated pipeline and is allowed to contain a per-note `pending_review` aggregate, so the builders emit accepted content plus safe metadata fallbacks. An absent/failed runner fails closed without formal build or publish. Task 4 tests inject a `ready_for_safe_build` fake; Task 5 wires the real deterministic runner. `local_only` single-note runs never publish.
- [ ] **GREEN — bounded CLI adapters.** Add the exact CLI stdout envelopes and Bridge parsers from `Bridge ↔ Node subprocess boundary`; invoke both Node programs only through `run_bounded_subprocess()` with fixed paths/cwd/environment/limits. Keep filesystem transaction details private and expose only safe outcome/count/build-version fields to the phase reducer.
- [ ] **GREEN — persistent idempotency and lock order.** Derive `finalization_key=sha256(run_id + sealed_scope_digest + input_revision_digest)` and atomically persist `not_started → building → built → publishing → terminal` plus `published_build_version`. Under a single-writer/process lock, duplicate acknowledgements and callbacks after restart replay the stored terminal result without another build/publish. Lock order is global run lock → per-run state → snapshot journal; Node/network work occurs outside held locks, then compare-and-set commits the expected state. Race tests cover duplicate callback, halt-vs-claim, restart while built, and stale worker completion.
- [ ] **REFACTOR/VERIFY.** Keep existing KB and public rollback helpers; delete dead `--summaries` argument rather than adding a second source. Run all bridge race/safety/publish tests.
- [ ] **COMMIT.** `fix: publish one finalized organization snapshot`.

### Task 5: Close the deterministic candidate/evidence/audit pipeline

**Dependencies:** Tasks 2–4 content/state/finalizer contracts. **Risk:** High — atomic multi-file state must preserve accepted history on any failure. **Outcome:** no-Agent runs always produce candidate/audit/build-ready state or an exact pending reason.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/generate-curation-candidates.mjs`
- Create: `skills/xhs-favorites-organizer/scripts/normalize-evidence.mjs`
- Create: `skills/xhs-favorites-organizer/scripts/run-curation-pipeline.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/prepare-curation-scope.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/initialize-curation-audit.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/merge-curation-results.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/validate-curation.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`

**Covers:** Spec §4, §5.5–§5.6, §8 BUG-01/02/03/15, §9.1–§9.2, §10 Step 4, AC-01/02/15.

- [ ] **RED — complete no-Agent run.** Build a synthetic scope with one current point record, one metadata-only record, one accepted non-resource note and one accepted Skill. Assert the pipeline creates candidate seeds, normalized evidence, resource assessments and pending bootstrap audit; no acceptance is restored before final candidate sealing. The non-resource note restores without a fake resource dependency; the Skill restores only with a fresh same-identity resource snapshot. Inject process failure at every curation journal boundary and assert recovery exposes one complete old or new candidates/resource-assessments/formal-resources/audit/curation generation, never a mixed set.
- [ ] **RED — candidate honesty.** Assert missing evidence yields `pending_review` with `evidence_missing`; generated summary/action never invent tools; no missing candidate file stops the chain; repeat run produces identical semantic JSON and no duplicates.
- [ ] **RED — audit bootstrap and status-aware merge.** With no prior review file, assert audit initialization occurs before candidate generation and creates one pending placeholder per scoped ID. For prior accepted work it carries only bounded revision references, never an accepted claim. Assert evidence attach or resource assessment changing a candidate after its seed causes a different final `candidate_revision`; status-aware merge restores accepted only after that final revision and all applicable dependencies match. Assert pending/rejected incomplete candidates can merge as private state without satisfying accepted candidate requirements, while `accepted` with the same missing fields fails validation and cannot enter formal curation.
- [ ] **RED — Task 7 resource seam.** Run Task 5 without the later GitHub verifier. Assert explicit existing complete registry IDs are preserved only when fresh, while ambiguous/incomplete/new Skill resources become `resource_pending` and `candidateKind=Skill`; no incomplete item is promoted. Inject exact verified/stale assessments and reject missing/extra assessment or resource keys. Advance the injected UTC day from 30 to 31: without refresh the Skill loses confirmed eligibility; a same-identity refresh restores the prior acceptance, while changed repo/license/manifest/compatibility identity makes curation stale.
- [ ] **Run RED.** Run `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`; expected failure because candidate producer/orchestrator are absent.
- [ ] **GREEN — audit bootstrap.** Split `initialize-curation-audit.mjs` so `initializeAuditForScope({ scope, catalog, existingAudit, curation })` runs before candidates/review and creates a content-hash-bound pending placeholder for every scoped ID. A placeholder for prior accepted work retains only bounded prior revision hashes as revalidation inputs when they exist; it never claims accepted/current, invents a new `evidence_sha256`, or claims comments/evidence were checked. Evidence-derived hash, methods, blockers and any accepted passthrough are added only by the later status-aware merge after current normalized evidence exists.
- [ ] **GREEN — candidate generator.** Export `generateCandidates({ catalog, scope, profile, priorCandidates })`. A prior accepted candidate is reused only as revision-bound candidate input, not as a current acceptance decision; metadata creates a conservative pending skeleton with empty `tools`; every skeleton carries `content_sha256`, `candidate_seed_revision` and initial blockers, but it cannot carry a final `candidate_revision` or consume raw/normalized evidence before the approved attach stage.
- [ ] **GREEN — normalized evidence, resource attach and final seal.** Export `normalizeEvidencePacket()` with only sanitized derived text, supported claim markers, unresolved facts and exact `{method, provider, version, result_sha256}` dependencies, plus `attachEvidenceToCandidates()` and `sealCandidateRevision()`. Compute `evidence_sha256` only after actual methods are known; attach the closed resource assessment next; then compute the final `candidate_revision` over every review-visible candidate field plus content/evidence hashes, stable resource ID/identity and blockers. A current point may seed summary/action only during evidence attach. Any evidence/resource mutation after sealing is rejected and requires resealing before review; raw media/comments remain private inputs and never enter public output/report.
- [ ] **GREEN — complete review set.** Build exactly one merge item per sealed scope ID only after final candidate sealing. Current accepted IDs whose content, evidence, final candidate, curation and applicable evidence/resource dependencies match receive an unchanged accepted passthrough item. Non-resource notes do not need a resource hash. When the verifier refreshes a stale resource snapshot, passthrough survives only if the refreshed identity hash is unchanged; identity changes require review. When a human/Agent review adapter is configured, it supplies explicit results only for the remaining IDs and must match those IDs exactly; when absent, the orchestrator synthesizes pending items from attached evidence/resource blockers without claiming semantic review. Duplicate, omitted, extra or out-of-scope IDs fail before merge.
- [ ] **GREEN — status-aware merge.** Refactor `mergeResults()` to validate the audit status before candidate strictness. `accepted` still requires the complete candidate/resource/claims contract and writes formal curation; `pending`/`rejected` retain only a bounded private skeleton plus exact blockers/reason and always delete that ID from formal curation. Reuse the same validator in the final quality gate so a later review cannot bypass it.
- [ ] **GREEN — resource assessment seam.** Define one exact-key assessment shape `{ status, resource_id, reason_code, resource_identity_sha256, verification_snapshot_sha256, resource }`; `resource` is either `null` or the complete bounded verified/stale snapshot from the Target contract. Status/hash/null combinations are closed and validated; extra/search/response fields fail closed. Task 5’s default adapter is registry-only: it preserves only an already complete/fresh explicit stable resource ID and marks new/incomplete/ambiguous Skill entities pending. Task 7 supplies the official GitHub verifier through this seam. Pending/stale outcomes persist privately in `.xhs-favorites/resource-assessments.json`; only complete verified snapshots enter the formal resource registry.
- [ ] **GREEN — crash-recoverable curation transaction.** `run-curation-pipeline.mjs` first calls `recoverCurationTransaction()` and then creates a private same-volume transaction directory beneath `.xhs-favorites`. It executes the approved order exactly: prepare scope → initialize audit placeholders → generate candidate seeds → attach normalized evidence → assess entity/resources → seal final candidate revisions → load optional review results → status-aware merge → validate. After all staging files pass schema/privacy checks, persist and flush a participant-aware journal for `curation-candidates.json`, private `resource-assessments.json`, formal `references/software-resources.json`, `curation-audit.json` and formal curation. Record each participant backup/swap boundary rather than collapsing multiple filesystem operations into one state. In-process failure rolls back before returning; process death is recovered idempotently at the next Bridge startup/finalizer so consumers observe one complete old or new generation before snapshot build. The committed generation manifest and Task 4 `input_revision_digest` include all five participant digests. A failed generation moves to private quarantine with only a sanitized manifest exposed through status; it never deletes diagnostic staging or copies it into public/report paths. Reuse the same generalized journal helper introduced for Task 4 rather than implementing incompatible transaction semantics.
- [ ] **GREEN — Bridge integration.** Invoke the orchestrator exactly once from the run-level finalizer through the approved CLI envelope and parser. After staging validation, return Task 4’s typed `ready_for_safe_build` result even when aggregate curation is `pending_review`; map accepted/pending/rejected/resource counts to phase state. No Agent or review result is a valid `organization_partial`, not a failure and not full success, and builders emit only accepted content plus safe metadata fallback.
- [ ] **REFACTOR/VERIFY.** Remove `--summaries` dead contract; use imports rather than copying quality logic. Run curation tests twice against same fixture and compare semantic outputs excluding timestamps.
- [ ] **COMMIT.** `feat: orchestrate deterministic curation candidates`.

### Task 6: Add safe fallback dispatch and resumable per-note semantics

**Dependencies:** Tasks 3 and 5 note state/evidence packet. **Risk:** High — fallback must never become a safety-limit bypass. **Outcome:** only safe cached offline evidence is attempted, and resume selects exactly needed notes.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/extract-pending-image-text.py`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `skills/xhs-favorites-organizer/scripts/download-pending-media.py`
- Modify: `skills/xhs-favorites-organizer/scripts/transcribe-pending-videos.py`
- Modify: `skills/xhs-favorites-organizer/scripts/run-video-analysis.ps1`
- Modify: `skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs`
- Modify: `config/xhs-favorites.example.json`
- Modify: `skills/xhs-favorites-organizer/tests/test_media_queue.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_transcription_pipeline.py`
- Create: `skills/xhs-favorites-organizer/tests/test_image_ocr.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_pipeline.py`

**Covers:** Spec §5.5, UX-04/12/13, BUG-07/08, AC-07/08/12/15.

- [ ] **RED — dispatcher table.** Test exact cases: safe point transport failure + cached video → audio; cached image + configured local OCR → OCR; missing tools → `evidence_status=missing`, `curation_status=pending_review`, `reason_code=ocr_unavailable|evidence_missing`; safety signal → no fallback; remaining notes → `batch_aborted`; rerun → only failed/aborted/stale.
- [ ] **RED — OCR producer.** With a fake local OCR executable and private JPEG fixture, assert `image-ocr.json` is written atomically with method/hash/text metadata; assert stdout/status never contains OCR text or paths. Missing executable returns a safe machine reason without partial file.
- [ ] **Run RED.** Run `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_media_queue.py"`, `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_transcription_pipeline.py"`, `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_image_ocr.py"`, and `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`; expected only the new requirement assertions fail.
- [ ] **GREEN — fallback dispatcher.** Add `dispatch_evidence_fallback(note_id, reason)` to Bridge. A point failure first retains the failed point page and terminates the remaining point browser batch exactly as the existing Skill contract requires; the dispatcher runs only afterward as a separate cached/offline evidence phase. It never closes that failed page, retries point/platform, resumes the point batch, or interprets offline fallback as point success. It first records public text/comment availability, then invokes offline transcript or local OCR only when the media is already cached and the corresponding private config is enabled. Dense frames remain manual/conditional.
- [ ] **GREEN — local OCR adapter.** Accept an explicit private `image_analysis.ocr_executable`; invoke it once per cached image with timeout/output bounds and no shell. Write only private JSON; classify engine missing/timeout/invalid output precisely.
- [ ] **GREEN — resume plan.** Generate summary/evidence plans from current note states and content hashes. Skip current captured/accepted, resume `failed`, `batch_aborted`, `stale` or explicitly selected notes; preserve successes across later failure.
- [ ] **REFACTOR/VERIFY.** Run safety tests proving no fallback, media request or retry after the first safety signal. Run all Python tests.
- [ ] **COMMIT.** `feat: resume organization with safe evidence fallbacks`.

### Task 7: Enforce confirmed Skill ↔ verified resource as one invariant

**Dependencies:** Task 5 candidate/resource queue. **Risk:** High — entity ambiguity can produce a credible but wrong repository. **Outcome:** confirmed Skill is impossible without exactly one complete, fresh, official resource.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/resource-quality.mjs`
- Create: `skills/xhs-favorites-organizer/scripts/verify-github-resources.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/validate-curation.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/generate-curation-candidates.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/build-public-site.mjs`
- Modify: `config/domain-profiles/software.json`
- Modify: `skills/xhs-favorites-organizer/references/software-resources.json`
- Modify: `skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`

**Covers:** Spec §5.7, UX-08/09, BUG-04/05/14/16, AC-04/05.

- [ ] **RED — schema and revision matrix.** Assert confirmed Skill rejects zero resources, multiple resources, aliases without stable ID, non-GitHub canonical repo, missing ZIP/release, license, manifest, verified date, stars, compatibility, compatibility evidence locator or either resource revision hash. With an injected UTC `today`, assert exactly 30 days old is fresh, 31 days old is stale, and invalid/future dates are stale under `resource_index.verification_max_age_days=30`. Advance the clock across month/year/leap-day boundaries and run under non-UTC process timezones to prove UTC calendar-day behavior. Assert stars/date/default-branch refresh changes only `verification_snapshot_sha256`, while repo/license/manifest/compatibility/evidence changes `resource_identity_sha256`; other resource kinds continue using their domain rules.
- [ ] **RED — no keyword confirmation.** Replace the current test that expects “三个 Codex 神级 Skill” metadata to produce `kind=Skill`. New expectation: confirmed `kind` is the neutral domain fallback, `candidateKind="Skill"`, `resources=[]`.
- [ ] **RED — network-isolated verifier.** Inject fake GitHub API responses and assert only an evidence-supplied canonical owner/repo is queried; no search endpoint, credential, retry or similar-name substitution is used. Cover invalid owner/repo grammar, redirect, wrong host, oversized/malformed response, non-default branch, 403/429 and timeout. Every failure maps to pending/stale, never a guessed link or leaked response body.
- [ ] **Run RED.** Run `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` and `npm.cmd run test:site`; current fallback and resource projection must fail the new requirement assertions.
- [ ] **GREEN — shared resource quality.** Add `resource_index.verification_max_age_days=30` to the software profile. Export `normalizeResourceId`, `validateVerifiedResource`, `resourceIdentityRevision`, `verificationSnapshotRevision`, `resourceFreshness(resource, { today, maxAgeDays })`, and `confirmedSkillResource`; reject missing/non-integer/negative policy values rather than silently defaulting. Parse only strict real `YYYY-MM-DD` values and perform Gregorian day-number arithmetic from the injected UTC date, never local-midnight millisecond arithmetic. Use this module and the same profile value in validation, both builders and migration; require exactly one stable resource ID for a confirmed Skill.
- [ ] **GREEN — official verification adapter.** Implement Task 5’s exact resource-assessment seam: accept a strict evidence-supplied canonical owner/repo grammar plus an optional evidence/registry-supplied manifest path, then construct requests internally. Allow only HTTPS `api.github.com`, `github.com` and `codeload.github.com`; disable redirects or revalidate every hop; never accept a response/payload URL as a request target. Apply header/body limits, fixed per-request timeout, bounded stage deadline/concurrency and zero retry. Fresh verified records cause zero network calls. Use the repository metadata endpoint to bind owner/repo, default branch, stars and license; use an exact contents endpoint for a supplied manifest path, or a bounded same-repository tree listing to require one unambiguous `SKILL.md` before fetching it. Derive the archive URL locally from the API-confirmed `default_branch`. Compatibility is accepted only from fetched official manifest/README text or an existing current registry field with an official repository-relative evidence locator; record that locator. Return the exact assessment plus complete bounded resource snapshot and both revision hashes; malformed/extra data, multiple manifest matches, 403/429 and limit exhaustion remain pending/stale without response text in logs.
- [ ] **GREEN — persist resources with the curation generation.** Add stable IDs/status/revision fields to seed entries that can be proven from existing official fields; mark incomplete/old entries `stale` or `candidate` instead of fabricating data. Treat the checked-in registry as the formal sanitized seed/output, never as the store for pending diagnostics. The orchestrator stages verified changes into the same Task 5 journal generation as candidates/audit/curation, while pending/stale assessments stay private. The builder continues to list valid non-Skill resources, but never confirms an incomplete or mixed-generation Skill.
- [ ] **GREEN — candidate kind.** `fallbackEntry()` returns neutral `kind`; it adds `candidateKind="Skill"` only when the deterministic classifier returns Skill while the public Skill gate is unmet. Filters and labels come from profile metadata. Accepted curated kind remains authoritative only after resource validation.
- [ ] **REFACTOR/VERIFY.** Assert public data contains no confirmed Skill without exactly one verified resource and two required safe actions. Run privacy scan.
- [ ] **COMMIT.** `fix: require verified resources for public skills`.

### Task 8: Show every safe action and a loopback-only pending evidence overlay

**Dependencies:** Tasks 3 and 7 state/resource projections. **Risk:** High — the overlay is private and must not cross the public boundary. **Outcome:** local users see pending evidence safely, public users see only safe state, and all verified actions are accessible.

**Files:**
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py`
- Modify: `site/local-bridge-utils.mjs`
- Modify: `site/app.js`
- Modify: `site/styles.css`
- Modify: `site/index.html`
- Modify: `skills/xhs-favorites-organizer/tests/test_bridge.py`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`
- Modify: `site/e2e/organization-recovery.spec.mjs`

**Covers:** Spec §5.8, §7 UX-05/06/07/08/09, BUG-06/13, AC-03/06/10.

- [ ] **RED — local overlay boundary.** Test authenticated manager-origin `GET /notes/organization-status?note_id=...` returns only note state, captured point summary, evidence method labels and blockers. Unauthorized/public origin, invalid ID or oversized record returns no evidence. Raw comments/OCR/media paths never appear.
- [ ] **RED — all actions.** Mount detail with one verified resource containing repo, ZIP and documentation actions. Assert all safe actions render in deterministic order, unsafe URLs are omitted, each link is keyboard-focusable and has an accessible label.
- [ ] **RED — public/private separation.** Playwright opens the same pending note from public origin and local workbench. Public shows safe fallback + exact pending reason only; local shows a clearly labeled “待审核证据” section. Accepted point shows source, reviewed date and evidence label.
- [ ] **Run RED.** Run `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_bridge.py"`, `npm.cmd run test:site`, and `npm.cmd run test:e2e`; current `.find()` and absent overlay must fail.
- [ ] **GREEN — endpoint.** Implement `local_note_overlay(note_id)` and the authenticated loopback route. In addition to Host/Origin/token checks, require the stable ID to belong to the sealed/current catalog revision. Build a distinct overlay projection from current note state and the validated private point record; use an exact key set and length/count caps. Unauthorized, unknown and stale IDs use non-enumerating safe responses. Sanitize diagnostics; service workers, public builders and caches never receive overlay data.
- [ ] **GREEN — frontend state arc.** Add `state.noteOverlays`, `refreshNoteOverlay(noteId)` and overlay rendering in `openNote()`/`renderDetail()`. Use one `role=status aria-live=polite aria-atomic=true` region for loading/result/error, deduplicate announcements and never move focus. Keep accepted formal summary visually separate; the public DOM contains no overlay section or request path.
- [ ] **GREEN — action renderer.** Replace `.find()` with a shared `safeResourceActions(resource)` mapping used by resource cards and detail. Render every action after URL validation with `target=_blank` and `rel=noreferrer`.
- [ ] **REFACTOR/VERIFY.** Run `npm.cmd run lint:a11y`, `npm.cmd run test:e2e`, and existing dialog scroll/focus tests through `npm.cmd run test:site`.
- [ ] **COMMIT.** `fix: display complete resources and review status`.

### Task 9: Unify formal private KB and public acceptance, including Skill outcomes

**Dependencies:** Tasks 2, 4, 5, 7 and 8 shared contracts/dual-output transaction. **Risk:** High — two builders must not diverge inside the already journaled swap. **Outcome:** both formal outputs use one trust decision and accepted Skills receive complete outcome artifacts.

**Files:**
- Modify: `skills/xhs-favorites-organizer/scripts/build-knowledge-base.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/build-public-site.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/curation-quality.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/resource-quality.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_knowledge_base.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`

**Covers:** Spec §5.8–§5.9, BUG-01/03/12/15, AC-01/02/04/05/11/13.

- [ ] **RED — cross-builder parity.** Feed current accepted, pending point, stale point and metadata-only fixtures into both builders. Assert formal summary source/eligibility agree for every ID; pending raw point never appears in Markdown or public JSON.
- [ ] **RED — Skill outcome.** For an accepted confirmed Skill, assert the KB card and `knowledge-base/05-Skills成果/GitHub-Skills核验清单.md` include official name/type/repo/ZIP/stars/date/license/manifest/compatibility/status. For candidate Skill, assert it appears only as pending/candidate and has no guessed link.
- [ ] **RED — transactional build regression.** Reuse Task 4’s fault-injection coordinator while adding accepted/pending fixtures. Force the second builder and each swap boundary to fail; assert previous KB and public JSON bytes remain unchanged, `build.status=failed`, `build.artifact_status=held_previous`, and publisher is not called.
- [ ] **Run RED.** `npm.cmd run test:knowledge` plus focused public/contract tests; current KB raw point behavior and missing Skill outcome file must fail.
- [ ] **GREEN — one acceptance projection.** Extend `curation-quality.mjs` to return a structured `formalCurationDecision` with `accepted`, `reason_code`, `summary_source`, `content_sha256`, `evidence_sha256`, `resource_ids`. Both builders consume it; neither calls `loadDiandianSummary()` as an independent acceptance path.
- [ ] **GREEN — KB formal output.** Raw point remains private outside formal KB. Generate the Skill outcome file from accepted confirmed Skills and add a “Skill 核验” block to corresponding cards. Preserve user-authored non-generated files through the existing staging/backup/live transaction.
- [ ] **GREEN — public output.** Emit `summaryStatus`, `summaryReason`, `candidateKind`, `reviewedAt`, safe evidence labels, unique resource IDs and `buildVersion`; scan before atomic replace.
- [ ] **REFACTOR/VERIFY.** Run both builders twice and compare semantic output; force failure and verify exact prior bytes. Run public sensitive-data scan.
- [ ] **COMMIT.** `fix: unify trusted summaries across formal outputs`.

### Task 10: Add dry-run-first migration and recoverable backfill

**Dependencies:** Tasks 2, 3, 7 and 9 target schemas. **Risk:** High — legacy facts are incomplete and live data must not be guessed or lost. **Outcome:** synthetic migration proves conservation/rollback; real migration stays explicitly user-triggered.

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/migrate-organization-state.mjs`
- Create: `skills/xhs-favorites-organizer/test-fixtures/organization-migration-v1.json`
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/public-tree-policy.mjs`
- Modify: `skills/xhs-favorites-organizer/references/curation-standard.md`

**Covers:** Spec §5.10, §10 Step 9, §13.1, UX-12/14, AC-08/11/14.

- [ ] **RED — migration conservation.** Use only the synthetic fixture: current accepted, valid legacy point, invalid point, old unresolved, false Skill candidate, duplicate stable ID. Assert dry-run writes no live files; report contains counts only; total input IDs equal migrated+unchanged+pending/rejected; duplicates do not increase.
- [ ] **RED — rollback.** Force failure between staging and swap. Assert live private/public snapshots remain byte-identical and backup manifest contains no private values.
- [ ] **Run RED.** Run `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs`; expected the migration contract tests fail because `migrate-organization-state.mjs` is absent.
- [ ] **GREEN — dry-run default.** Implement `planMigration()` and CLI. Resolve stable IDs, calculate body-only content hashes and independently normalized evidence hashes, derive point `summary_sha256` from the cleaned persisted reply, bind exact method/provider/version/result dependencies, map indeterminate historical failures to `unknown_legacy`, and retain current accepted curation only after a final candidate revision is sealed and every applicable dependency matches. A non-resource note does not acquire a fabricated resource dependency; a resource record derives separate identity/snapshot revisions, preserves acceptance only for a fresh same-identity snapshot refresh, and becomes candidate/stale when identity proof is incomplete, changed or older than policy. Never infer an attempted failure from a batch-wide old reason. Output contains only safe counts, a deterministic dry-run ID, expiry and an exact guarded next-command template; a stale/mismatched confirmation returns the closed instruction to rerun dry-run without touching live data.
- [ ] **GREEN — guarded apply.** `--apply` additionally requires `--confirm <dry-run-id>` matching a fresh report. Create private backup and staging directories, validate counts/privacy/schema, then use Task 4's `journaled-transaction.mjs` participant API for every migrated live target and emit a safe rollback manifest. Fault tests terminate at each durable participant boundary and require one complete old or new generation after recovery. Do not fetch platform or GitHub during migration.
- [ ] **GREEN — public policy.** Add migration report/backups to private-tree exclusions; tests prove none can enter `site/` or Git tracking.
- [ ] **REFACTOR/VERIFY.** Run dry-run twice for identical count plan; run fault-injection rollback. Do not execute `--apply` against the user’s real `.xhs-favorites/` during this pipeline.
- [ ] **COMMIT.** `feat: add recoverable organization state migration`.

### Task 11: Documentation and pre-review verification

**Dependencies:** Tasks 0–10 green. **Risk:** Medium — documentation can drift from the final code. **Outcome:** project docs and automated pre-review commands match the implementation, ready for the pipeline’s separate Review/QA/Audit/Brief agents.

**Files:**
- Modify: `skills/xhs-favorites-organizer/SKILL.md`
- Modify: `skills/xhs-favorites-organizer/references/automatic-workflow.md`
- Modify: `skills/xhs-favorites-organizer/references/curation-standard.md`
- Modify: `skills/xhs-favorites-organizer/references/organization-schema.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PUBLISHING.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`
- Modify: `skills/xhs-favorites-organizer/tests/test_public_site.mjs`

**Covers:** Spec §3–§15 documentation plus the code-stage automated subset of `VC-AUTO-*`; downstream agents close Review/QA/Audit/Brief items after this task.

- [ ] **RED — documentation contracts.** Add assertions that the project Skill and workflow reference name one final publish after curation; distinguish captured/pending/accepted; require candidate Skill vs confirmed Skill; document `failed` vs `batch_aborted`; and link the governance flow. This paired fixture is mandatory because the project Skill body changes.
- [ ] **GREEN — update docs.** Remove the obsolete claim that formal KB directly displays any valid raw point and that publication can happen after each last board before summary planning. Document exact user-triggered entry, no-model core, local overlay, dry-run migration, reason codes, rollback, and human PR gate.
- [ ] **GREEN — update contributor golden path.** Put the Node 20/Python 3.12 requirements and the DX command matrix near the start of CONTRIBUTING. Map change types to the smallest focused command and the full release gate; document fixture scenarios/help, safe report/artifact locations, Windows-only tests and that real migration apply stays outside the pipeline. Documentation contract tests assert these executable facts, not only product prose.
- [ ] **VERIFY — static and unit.** Run `npm.cmd run check:syntax`, `node --test scripts/test-verify-development-lifecycle.mjs scripts/test-check-syntax.mjs`, `npm.cmd run lint:a11y`, `npm.cmd run release:check`, and `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"`. Expected: every command exits 0; syntax runner reports every tracked JS/MJS checked; focused and full suites retain the same behavioral assertions.
- [ ] **VERIFY — browser.** Run `npm.cmd run test:e2e`. The test drives both configured Chromium projects through keyboard-only navigation, local overlay isolation, all resource actions, and success/partial/build-failed/publish-failed/safety-stopped arcs. Expected: exit 0 with no unexpected console error or failed request.
- [ ] **VERIFY — Windows safety contracts.** Register `npm.cmd run test:windows-contracts` as the four explicit `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` invocations for `test_setup_browser_profile.ps1`, `test_setup_transaction.ps1`, `test_setup_xhs_downloader.ps1`, and `test_start_autosync.ps1`, then run that command in the Windows CI job. It must exit 0; tests must not start a second profile, read credentials or create a scheduled/startup task.
- [ ] **VERIFY — fault and privacy.** Re-run build failure rollback, publish failure, safety stop, migration dry-run, tracked-private-path scanner and public tree scan. Expected exact prior snapshots retained and zero sensitive findings.
- [ ] **COMMIT.** `docs: align organizer workflow with verified lifecycle` after paired tests are green.

---

## Post-implementation `/dev-pipeline` gates

These are pipeline stages after all Task 0–11 CODE commits; they are not delegated back into Task 11 and cannot be claimed by the implementation agent.

1. **Step 5 — REVIEW.** An isolated Review Agent reads the branch diff, governing Spec, Plan and checklist, writes the canonical `docs/reports/reviews/*-review.md`, fixes authorized findings, and reruns every impacted focused test. P0/P1 must be zero before QA.
2. **Step 6 — QA.** An isolated QA Agent uses `npm.cmd run preview:qa-fixture` and the real rendered site to execute `VC-QA-01..15`, including both automated Entry → Action → Expected Result journeys and the two correctly tagged manual-only judgments. It writes `docs/reports/qa/*-qa-report.md`; it never accesses the real platform or private user data.
3. **Step 7 — AUDIT.** An isolated coverage/audit Agent reconciles Spec §3–§15, BUG-01..16, UX-01..14, AC-01..15 and every stable checklist ID against tests, review and QA evidence; it writes `docs/reports/test-outcomes/*-test-outcome.md` and reruns the complete release/privacy gates. P0/P1 and unassigned functional item counts must remain zero.
4. **Step 8 — BRIEF.** An isolated Brief Agent writes `docs/reports/briefs/*-brief.md` with exact branch/base, commits, RED/GREEN evidence, commands/exit codes, rollback, remaining P2/P3, and the fact that real migration apply, PR, push, merge and deploy have not occurred. The pipeline stops for user validation.
5. **Human/PR boundary.** PR creation is allowed only after the user approves that brief. The PR lifecycle gate then resolves the linked canonical artifacts; real Ubuntu/Windows CI must pass before any later merge/deploy discussion.

---

## Test Plan Artifact

| Test ID | Layer | Automated command / entry | Contract and expected result | Spec / checklist mapping |
|---|---|---|---|---|
| TP-001 | Governance unit | `node --test scripts/test-verify-development-lifecycle.mjs` | Missing APPROVED Spec/Plan/TDD/Review/QA/Brief/rollback fails with exact gate IDs; complete PR passes | §14, VC-GOV-01..08 |
| TP-002 | Python state unit | `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"` | Full note/run transitions, legacy mapping, failed vs batch_aborted, truthful completion | §6, UX-02/04/10/11/12/14, AC-07/08/10 |
| TP-003 | Point revision unit | `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_bridge.py"`; `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`; `python -m unittest discover -s ".\skills\xhs-diandian-summarize-note\tests" -p "test_save_summary.py"` | Captured v2 binds trusted current body/provider/prompt hashes and cleaned-reply `summary_sha256` without changing external saver API 1; `request_sha256` remains save idempotency only; provider/prompt change reschedules point, while comment/other-method evidence changes do not; payload cannot forge destination/revision; traversal/reparse/symlink is rejected; commit failure preserves old bytes | §5.4, UX-03/14, AC-02/08 |
| TP-004 | Curation contract | `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` | Audit placeholders precede candidate seeds without false evidence claims; normalized evidence binds deterministic `evidence_sha256` and exact method/provider/version/result dependencies; accepted passthrough occurs only after evidence/resource attach and final candidate sealing; non-resource acceptance has no fake resource hash; saved point reaches status-aware merge/build; missing facts/resources remain pending; no Agent or future verifier dependency | §5.5–§5.6, BUG-01/02/03/15, AC-01/02/15 |
| TP-005 | Resource contract | `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` | Confirmed Skill has exactly one fresh verified resource with identity and verification-snapshot revisions; strict Gregorian UTC-day tests under non-UTC process zones prove day 30 inclusive/day 31 stale across month/year/leap boundaries; same-identity refresh preserves acceptance, identity change requires review; resource assessment/formal registry join the curation transaction; SSRF/redirect/wrong-host/oversize/malformed/default-branch/403/429 fixtures fail to pending without retry or leaked body | §5.7, UX-08/09, AC-04/05 |
| TP-006 | Public builder | `npm.cmd run test:site` | Metadata cannot confirm Skill; exact summary status/reason; accepted point only; all resource actions present in data | UX-06/07/08/09, BUG-04/05/13/16 |
| TP-007 | KB builder | `npm.cmd run test:knowledge` | Formal KB uses same acceptance decision as public; Skill result file complete; failure restores old tree | §5.8–§5.9, AC-02/04/05/11 |
| TP-008 | Bridge integration | `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_bridge.py"`; `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_organization_pipeline.py"`; `node --test skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs` | Two-stage scope plus empty/all-current paths; strict bounded subprocess envelopes; process restart at every journal boundary; duplicate callback/halt race across restart; no pre-gate publish and <=1 after; same-version dual-output recovery; overlay auth/current-catalog access | §5.1/5.2/5.9, UX-01/05/10/11/13, AC-03/09/10/11/12 |
| TP-009 | Media fallback | `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_media_queue.py"`; `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_transcription_pipeline.py"`; `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_image_ocr.py"` | Safe failure uses cached offline evidence when available; safety signal prevents fallback/retry; unavailable tools yield `evidence_status=missing` plus an exact reason | §5.5, BUG-08, AC-08/12/15 |
| TP-010 | Migration | `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` | Synthetic migration fixture proves dry-run no writes, count conservation, unknown legacy, stale, guarded apply and fault rollback | §10 Step 9, §13.1, AC-14 |
| TP-011 | Privacy | `npm.cmd run verify` | No private path tracked; public tree excludes overlay/evidence/migration/media/IDs/tokens | §3.3, §12, AC-13 |
| TP-012 | Syntax/static lint | `npm.cmd run check:syntax`; `npm.cmd run lint:a11y` | Every tracked JS/MJS parses and the installed ESLint configuration reports zero error on authored browser JS; imperative DOM accessibility is proved by TP-006/013, not inferred from JSX-only lint rules | UX-02..11, VC-UI-* |
| TP-013 | Browser E2E | `npm.cmd run test:e2e` | Real rendered Entry → Action → Result for success, partial, failures, overlay boundary, repo+ZIP and keyboard on desktop/mobile | UX-01..14, AC-03/06/10 |
| TP-014 | Full release | `npm.cmd run release:check` | Entire Node, both Python Skill suites and release/privacy contracts pass | §10 Step 10, §15 |
| TP-015 | Manual local QA | Start `npm.cmd run preview:qa-fixture`; open only the printed local fixture URL | Desktop/mobile readable, focus order and exact recovery guidance are understandable; harness performs no real platform/network access | UX-01..14, VC-QA-* |
| TP-016 | No-model process | `node --test skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` with a synthetic fixture whose model/Agent/network configuration keys are absent | Core, candidate state, build and safe pending result complete deterministically without Codex/Claude/Gemini or network | §3.1/3.3/5.6, AC-15 |
| TP-017 | Windows setup safety | `npm.cmd run test:windows-contracts` on the Windows CI job | SOP browser ownership, setup rollback, downloader setup and no-startup-task contracts stay green | §3.3/5.1, VC-SAFE-02/05, AC-12/13 |

### RED/GREEN evidence rules

- Every behavior task first runs its named focused test and records the exact requirement failure.
- GREEN is accepted only when the same test passes without changing the requirement assertion.
- REFACTOR reruns the focused suite plus adjacent safety/privacy tests.
- State-transition tests start before the transition, trigger the action, then assert the final visible/persisted state.
- `.todo()`, untagged manual-only, existence-only and implementation-output assertions do not count.
- The only manual-only items in this plan are tagged `[manual-only: visual-polish]` or `[manual-only: subjective-ux]`; all functional UI behavior has Playwright coverage.

---

## Execution, state and test-path diagrams

```text
HAPPY: click → freeze/seal → core → captured → evidence ready → accepted/resource verified
       → recover/commit one KB+public build_version → publish once/unchanged → truthful success

NIL:   click → frozen scope contains no actionable note → zero-count terminal phases
       → version reconciliation only when catalog output requires it → unchanged/local ready → “没有需要整理的新内容”

EMPTY: core saved → point/tool/resource unavailable → evidence missing / audit pending
       → safe metadata build → organization_partial → visible next action, no invented summary/link

ERROR: any typed failure → persist successful upstream work → block unsafe downstream edges
       → recover previous compatible artifact(s) → exact user copy + resumable state
       safety signal is terminal and bypasses every fallback/build/publish edge
```

```text
RUN FSM
idle → starting → core_completed → organization_partial ──resume──┐
                         │                                      │
                         ├→ organization_ready (publish off)    │
                         ├→ published (published/unchanged)     │
                         └→ completed_with_warnings             │
any phase ──safety──> safety_stopped                            │
core/snapshot unrecoverable ──> failed                           │
                                                                └─> next run

NOTE DIMENSIONS (orthogonal, never collapsed into one reason)
core: not_started|saved|unchanged|failed|safety_stopped
summary: not_required|not_started|running|captured|failed|batch_aborted|stale
evidence: missing|partial|ready|blocked
resource: not_applicable|candidate|verified|ambiguous|missing|stale
curation: not_started|pending_review|accepted|rejected|stale
public: not_eligible|ready|published|held_previous
```

```text
ERROR FLOW
validate input → attempt one bounded operation → persist typed dimension outcome
      │ invalid/timeout/oversize/403/429/crash
      v
closed error_code + phase + retryable + next_action
      ├─ safety? stop all work and publish nothing
      ├─ build? recover both local snapshots to one version
      ├─ publish? keep local new build and remote old build
      └─ per-note? preserve successes; failed current + batch_aborted remainder
```

```text
DEPLOY / ROLLBACK SEQUENCE
stage KB ─> validate ─> stage public ─> validate ─> persist prepared journal
  ─> backup old ─> swap KB ─> swap public ─> verify shared build_version ─> commit journal
  ─> publisher compare/push once iff explicitly enabled and not local-only

crash at any arrow ─> next startup recovery ─> both old OR both new ─> then and only then continue
publish failure ─> local new retained + remote old retained; no force push
real migration apply ─> outside this pipeline, after user-approved dry-run/count review
```

### Test path map

```text
Workbench click / rapid duplicate
  └─ TP-008 Bridge integration + TP-013 Playwright
      ├─ scope freeze/seal / empty / all-current
      ├─ API 1 staging + revision binding ── TP-003
      ├─ failed vs batch_aborted / resume ── TP-002/009
      ├─ candidate/audit/resource ── TP-004/005/016
      ├─ KB/public trust parity ── TP-006/007
      ├─ journal restart / duplicate finalizer ── TP-008
      ├─ local overlay / public isolation / all actions ── TP-008/013
      └─ privacy + full release ── TP-011/014/017

Every changed user edge has: RED assertion → same GREEN assertion → adjacent safety suite → QA journey.
```

## Design Review: UI behavior contract

No mockup or new information architecture is required. Implementations reuse the current three views, tokens, native dialog, resource-action component and breakpoints.

| UX | Entry → Action | Required visible result |
|---|---|---|
| UX-01 | Sync settings → click once / rapid duplicate click | Button disables immediately; one run and one frozen scope; no second request |
| UX-02 | Run panel → core transaction ends | Primary: `核心收藏已保存`; secondary: phase counts/status; tertiary: recovery CTA; never claim all outputs updated |
| UX-03 | Summary progress → one item succeeds | Captured count increments and the note reads `总结已捕获，等待审核`; later failures do not roll it back |
| UX-04 | Three-note plan → second transport fails | Second: `本篇总结失败，可在下次继续`; third: `本次未尝试，可继续整理`; counts remain distinct |
| UX-05 | Local detail → open captured/pending note | Overlay loading then a separate `待审核证据` region with method/blocker; it never impersonates formal summary |
| UX-06 | Public detail → open pending note | Safe metadata plus exact reason; no local descriptor/request/private DOM section |
| UX-07 | Public detail → open accepted/current point note | Formal summary, provenance, `reviewedAt`, evidence labels; missing required field fails back to non-accepted state |
| UX-08 | Confirmed Skill card → open detail | Exactly one verified resource is the primary action; zero/multiple resource cannot display confirmed Skill |
| UX-09 | Skill detail → inspect actions | Render every safe action in repo → ZIP → docs order; accessible names include resource + action; unsafe links are omitted |
| UX-10 | Run result → final build fails | `构建失败，已保留上一版`; core success remains visible; no “网页已经更新” |
| UX-11 | Run result → publisher fails | `发布失败，远端仍为上一版；本地结果已保留`; text/icons distinguish local and remote, not color alone |
| UX-12 | Partial/stale result → run again | CTA shows actionable count; request includes only failed/aborted/stale/selected; current accepted count is shown as skipped |
| UX-13 | Any active phase → first safety signal | Progress stops, automatic retry stays disabled, SOP verification guidance is visible, only a verified restart is offered |
| UX-14 | Accepted note → content revision changes | `正文已变化，等待重新审核`; old summary is not current formal content; public uses prior legal state or safe metadata |

### Visible state matrices

| Surface | Closed states | Rendering rule |
|---|---|---|
| Run panel | `idle`, `starting`, `running`, `core_completed`, `organization_partial`, `organization_ready`, `published`, `completed_with_warnings`, `failed`, `safety_stopped` | One highest-priority title; phase counts as secondary content; one contextual CTA; one deduplicated announcement per transition |
| Note card/detail | `not_started`, `captured_pending`, `failed`, `batch_aborted`, `evidence_missing`, `stale`, `accepted`, `overlay_unavailable` | Card has the short approved label; detail lists dimension reasons and next action; never color-only |
| Local overlay | `absent_public`, `loading`, `ready_pending`, `empty_safe`, `bridge_unavailable`, `stale` | Public state renders no node/request; local region uses visible loading/error and never steals focus |
| Resource actions | `empty`, `unsafe_omitted`, `one_verified`, `multiple_safe_actions` | Confirmed Skill with empty/ambiguous actions is a build error; valid actions have deterministic order and unique names |

### Responsive and accessibility contract

- `>=1181px`: preserve sidebar/workspace layout; the pending overlay follows formal summary and precedes resources.
- `841–1180px`: allow phase counts/actions to wrap while retaining title → detail → CTA order.
- `581–840px`: run panel and overlay become one column; fixed bottom nav cannot obscure the last CTA or dialog footer.
- `320–580px`: single column, no horizontal overflow at 400% zoom; long Chinese reasons/resource names wrap; interactive targets are at least 44×44 CSS px with 8px spacing. Desktop targets meet WCAG 2.5.8 minimum sizing/spacing.
- All run, filter, card, dialog, resource and resume actions are keyboard reachable; Enter/Space match click. Dialog open focuses the close control or titled region; Escape/close restores the triggering card and scroll position. Async overlay/status updates never steal focus.
- Use a dedicated `aria-live=polite aria-atomic=true` run status region; set `aria-busy` only for starting/running and do not repeatedly announce the full card grid. Focus must remain visible and unobscured; motion respects `prefers-reduced-motion`.
- Link names are `<resource name> 官方仓库`, `<resource name> 下载 ZIP`, etc.; new-window meaning is textual. Text contrast is >=4.5:1 and focus/UI indicators >=3:1. Automated checks cover focus return, Escape, announcement dedupe, target size, 320px/reflow, reduced motion and public/local request isolation; `VC-QA-14/15` retain only their approved visual/subjective manual checks.

## Developer Experience Contract

Primary implementers are Windows maintainers and isolated Review/QA agents; Ubuntu CI is a first-class execution environment.

| Intent | Windows PowerShell | POSIX / Ubuntu CI | Expected outcome |
|---|---|---|---|
| Install | `npm.cmd ci` | `npm ci` | Locked Node dependencies only |
| Fast organization loop | `npm.cmd run test:organization` | `npm run test:organization` | Python organization pipeline + Node organization contracts |
| Browser journeys | `npm.cmd run test:e2e` | `npm run test:e2e` | Chromium desktop/mobile synthetic journeys |
| Full release | `npm.cmd run release:check` | `npm run release:check` | All public, Python, privacy and lifecycle-compatible checks |
| Windows contracts | `npm.cmd run test:windows-contracts` | Not applicable | Only the Windows CI job runs PowerShell safety contracts |

- Package scripts use cross-platform Node wrappers; no PowerShell-only chain enters the common release script. Pin/document Node 20 and Python 3.12 consistently. With dependencies installed, the focused loop target is <=5 minutes; cold synthetic setup target is <=15 minutes and never needs the platform, private data, a model or credentials.
- Playwright `webServer` is the only automated fixture owner, with `workers=1`, `reuseExistingServer=false`, a closed `--scenario success|partial|build-failed|publish-failed|safety-stopped`, a safe `/__health`, fail-fast port-conflict guidance and deterministic SIGINT/SIGTERM/test cleanup. It prints one sanitized readiness JSON line; manual mode prints local/public URLs but never a token/path.
- `serve-qa-fixture.mjs --help` and CONTRIBUTING map every scenario to UX/VC IDs. Fixtures have fixed `schema_version`, deterministic timestamps/IDs and no private-shaped value; failures name the fixture and checklist ID.
- CLI failures use a closed envelope `{ok:false,error_code,phase,message,retryable,next_action}`. stderr starts with `CODE phase: what happened; next: <safe action>` and never contains a private path, ID, evidence body or stack. Tests assert exact code/action for invalid JSON, timeout/oversize, port conflict, missing browser/OCR and stale migration confirmation.
- On CI failure, upload only synthetic `test-results/` and `playwright-report/` traces/screenshots with short retention; console output gives a repository-relative path. Artifact rules explicitly reject `.xhs-favorites/`, `.xhs-tools/`, `knowledge-base/` and `site/.local/`. Canonical review/QA/test/brief evidence remains under `docs/reports/`.
- Migration dry-run prints only safe counts, a dry-run ID, expiry and an exact next-command template; stale/mismatch says to rerun dry-run. The pipeline never executes real `--apply`, and docs describe rollback manifests only by safe private-relative location.

## Safe observability and recovery registry

| Event | Allowed fields | User/operator next action |
|---|---|---|
| `run_started` | run ID, schema version, safe mode | Wait or cancel through the documented local control |
| `scope_sealed` | board/note counts, scope digest | If empty, confirm unchanged result; never inspect IDs in logs |
| `core_saved` | counts, duration, revision digest | Continue downstream; core remains recoverable |
| `summary_item_terminal` | aggregate captured/failed/aborted counts, reason | Resume only actionable states |
| `curation_validated` | accepted/pending/rejected/resource-pending counts | Review blockers; pending is not failure or acceptance |
| `snapshot_swapped` | build version, counts, duration | Eligible for publish only when explicitly enabled and not `local_only` |
| `publish_terminal` | published/unchanged/failed, build version | Failed: keep remote old and use local result |
| `safety_stopped` | phase, safety reason, counts | Verify manually in SOP browser; start a new run only afterwards |

No event includes paths, titles, board/note IDs, URLs, responses, comments, OCR/media or credentials.

### Error & Rescue Registry

| Failure | Persisted state / rescue | Retry? | User-visible copy | Proof |
|---|---|---|---|---|
| Point current item transport fails | current `failed`; remaining `batch_aborted`; earlier captured preserved | Next user run | Exact two note messages | TP-002/009/013 |
| Point staging validation/replace fails | old live bytes preserved; note not captured | Next user run | Single-note failure | TP-003 |
| Cached OCR/tool unavailable | evidence missing/pending with typed reason | After configuration/user run | Evidence missing copy | TP-009 |
| Safety signal during any phase | `safety_stopped`; cancel fallback/finalizer/publish | No automatic retry | Exact safety guidance | TP-008/009/013 |
| Curation CLI timeout/oversize/invalid envelope | old live curation retained; snapshot not called | New run after diagnosis | Partial/failed typed status | TP-004/008 |
| GitHub redirect/403/429/malformed/ambiguous | resource pending/stale; no guessed URL | Later explicit run, no auto retry | Resource pending reason | TP-005 |
| KB or public staging fails | no swap; prior pair retained | User rerun | Build failure copy | TP-007/008/013 |
| Crash at a snapshot journal boundary | startup recovers both old or both new; publish blocked until consistent | Automatic recovery once, then user-visible terminal | Recovery/build state | TP-008 |
| Duplicate finalizer/restart callback | persistent CAS replays terminal outcome | No duplicate work | Same terminal status | TP-008 |
| Publisher fails | local new pair retained; remote old retained | Later explicit publish/run | Exact publish failure copy | TP-008/013 |
| Migration fault/stale confirm | live unchanged; safe report says rerun dry-run | Explicit only, outside pipeline for real data | Safe dry-run guidance | TP-010 |

### Failure Modes Registry

| Integration edge | Realistic failure | Handling planned | Test planned | Visible/logged safely | Critical gap after review |
|---|---|---:|---:|---:|---:|
| Workbench → Bridge | duplicate click, bad Origin/token, port conflict | Yes | Yes | Yes | No |
| Bridge → point API 1 | traversal/reparse, invalid result, replace failure | Yes | Yes | Yes | No |
| Bridge → Node coordinators | timeout, non-zero, invalid/extra JSON, oversized output | Yes | Yes | Yes | No |
| Evidence fallback | missing tool/media, safety signal | Yes | Yes | Yes | No |
| Resource verifier | SSRF/redirect/rate limit/default branch/oversize | Yes | Yes | Yes | No |
| Curation merge | missing/duplicate/out-of-scope review item | Yes | Yes | Yes | No |
| Snapshot swap | crash at every durable journal state | Yes | Yes | Yes | No |
| Finalizer/publisher | restart, duplicate callback, halt race, remote failure | Yes | Yes | Yes | No |
| Local overlay | unknown/stale ID, auth failure, public request/cache | Yes | Yes | Yes | No |
| Migration | stale confirmation, count mismatch, swap fault | Yes | Yes | Yes | No |

All previously identified silent-failure combinations have rescue, test, visible state and safe event coverage; unresolved critical failure gaps: 0.

---

## Spec Coverage Matrix

| Spec scope | Implementation owner | Verification owner | Status |
|---|---|---|---|
| §3 goals/non-goals/invariants | Tasks 0, 2–11 | TP-011/014/016; VC-SAFE/GOV | ASSIGNED |
| §4 terms/trust hierarchy | Tasks 2, 5, 9 | TP-003/004/007 | ASSIGNED |
| §5.1 startup/safety | Tasks 3, 4, 8 | TP-008/013 | ASSIGNED |
| §5.2 frozen scope/scan | Tasks 3–5 | TP-002/004/008 | ASSIGNED |
| §5.3 core transaction | Tasks 2, 4, 9 | TP-003/007/008 | ASSIGNED |
| §5.4 summary plan/atomic save | Tasks 2–4 | TP-002/003/008 | ASSIGNED |
| §5.5 fallback/evidence | Tasks 5–6 | TP-004/009 | ASSIGNED |
| §5.6 candidate/audit | Task 5 | TP-004/016 | ASSIGNED |
| §5.7 Skill/resource | Task 7 | TP-005/006 | ASSIGNED |
| §5.8 outputs/overlay | Tasks 8–9 | TP-006/007/008/013 | ASSIGNED |
| §5.9 final build/publish | Tasks 4, 9 | TP-007/008/013 | ASSIGNED |
| §5.10 finish/retry | Tasks 3, 6, 10 | TP-002/009/010 | ASSIGNED |
| §6 orthogonal states | Task 3 | TP-002/013 | ASSIGNED |
| §7 UX-01..UX-14 | Tasks 3, 4, 6, 8, 9 | TP-002/006/008/009/013; VC-UX-01..14 | ASSIGNED |
| §8 BUG-01..BUG-16 | Tasks 2–9 | BUG matrix below | ASSIGNED |
| §8.1 protections to preserve | Tasks 2–11 | TP-007/008/009/011/014 | ASSIGNED |
| §9 root causes | Tasks 4–5, 7, 9 | TP-004/005/007/008 | ASSIGNED |
| §10 Step 0..10 | Tasks 0–11 | TP-001..017 | ASSIGNED |
| §11 AC-01..AC-15 | Tasks 2–11 | AC matrix below | ASSIGNED |
| §12 observability/log safety | Tasks 3, 5, 6, 8 | TP-002/008/009/011 | ASSIGNED |
| §13 rollback/release | Tasks 4, 9, 10, 11 | TP-007/008/010/014 | ASSIGNED |
| §14 permanent workflow | Tasks 0, 11 + Post-implementation Steps 5–8/Human gate | TP-001/014; VC-GOV | ASSIGNED |
| §15 Definition of Done | Tasks 0–11 + Post-implementation Steps 5–8/Human gate | Full checklist | ASSIGNED |

### Bug coverage

| Bug | Fix task(s) | RED/GREEN proof |
|---|---|---|
| BUG-01 | 2, 5, 9 | TP-003/004/007 |
| BUG-02 | 5 | TP-004 candidate producer |
| BUG-03 | 4, 5, 9 | TP-004/007 dead argument removed |
| BUG-04 | 7 | TP-005/006 no keyword confirmation |
| BUG-05 | 7 | TP-005 explicit canonical resource verification |
| BUG-06 | 8 | TP-013 all safe detail actions |
| BUG-07 | 3, 6 | TP-002/009 failed vs batch_aborted |
| BUG-08 | 6 | TP-009 safe fallback dispatcher |
| BUG-09 | 4 | TP-008 zero-before/one-after ordering |
| BUG-10 | 3, 4 | TP-002/008/013 build/finalizer truth |
| BUG-11 | 3, 4 | TP-002/008/013 publish truth |
| BUG-12 | 2, 9 | TP-003/007 cross-builder parity |
| BUG-13 | 3, 8 | TP-006/013 reason-driven UI |
| BUG-14 | 7 | TP-005 full/fresh resource schema |
| BUG-15 | 1, 5, 9, 11 | TP-004/007/008/013/014 |
| BUG-16 | 7 | TP-006 `candidateKind` contract |

### UX coverage

| UX | Task(s) | Checklist / test |
|---|---|---|
| UX-01 | 3, 4 | VC-UX-01; TP-008/013 |
| UX-02 | 3, 4 | VC-UX-02; TP-002/013 |
| UX-03 | 2, 3 | VC-UX-03; TP-003/008 |
| UX-04 | 3, 6 | VC-UX-04; TP-002/009 |
| UX-05 | 8 | VC-UX-05; TP-008/013 |
| UX-06 | 3, 8, 9 | VC-UX-06; TP-006/013 |
| UX-07 | 8, 9 | VC-UX-07; TP-006/013 |
| UX-08 | 7, 8 | VC-UX-08; TP-005/013 |
| UX-09 | 7, 8 | VC-UX-09; TP-005/013 |
| UX-10 | 3, 4, 9 | VC-UX-10; TP-007/008/013 |
| UX-11 | 3, 4 | VC-UX-11; TP-008/013 |
| UX-12 | 2, 3, 6, 10 | VC-UX-12; TP-002/003/009/010 |
| UX-13 | 3, 4, 6 | VC-UX-13; TP-008/009/013 |
| UX-14 | 2, 3, 10 | VC-UX-14; TP-002/003/010 |

### Acceptance coverage

| AC | Task(s) | Proof |
|---|---|---|
| AC-01 | 5, 9 | TP-004/007 |
| AC-02 | 2, 5, 9 | TP-003/004/007 |
| AC-03 | 8 | TP-008/013 |
| AC-04 | 7, 9 | TP-005/007 |
| AC-05 | 7, 9 | TP-005/007 |
| AC-06 | 8 | TP-013 |
| AC-07 | 3, 6 | TP-002/009 |
| AC-08 | 2, 3, 6, 10 | TP-002/003/009/010 |
| AC-09 | 4 | TP-008 |
| AC-10 | 3, 4, 8 | TP-002/008/013 |
| AC-11 | 4, 9, 10 | TP-007/008/010 |
| AC-12 | 3, 4, 6 | TP-008/009/013 |
| AC-13 | 0, 8–11 | TP-001/011/014 |
| AC-14 | 10 | TP-010 |
| AC-15 | 5, 6, 11 | TP-004/009/016 |

No Spec section, BUG, UX contract or AC is deferred or unassigned.

---

## Risks and mitigations

- **Risk: Bridge 已超过 4,700 行，继续堆叠会扩大竞态。** Mitigation: 状态 reducer 抽到 `organization_state.py`，Node 数据逻辑保持独立模块；Bridge 只负责编排和 I/O。
- **Risk: 资源自动核验误配相似仓库。** Mitigation: 只接受证据中明确 canonical `owner/repo` 或既有稳定 resource ID；不使用 GitHub 搜索、不按名称猜测。
- **Risk: 新严格门使旧“Skill”数量下降。** Mitigation: 这是批准 Spec 的正确语义；保留 `candidateKind` 与资源待核验原因，不删除收藏，不伪造链接。
- **Risk: Playwright 增加依赖和 CI 时间。** Mitigation: 只安装 Chromium，固定单 worker、fixture route、无真实平台访问；保留 Node mounted tests作快速反馈。
- **Risk: OCR/转写工具不可用。** Mitigation: 显式配置、本地离线、一次调用；无工具时使用 `evidence_status=missing`、`curation_status=pending_review` 和精确 reason code，不通过联网或平台重试补偿。
- **Risk: 多看板/点点线程重复最终化。** Mitigation: 持久 run-level claim + build version 幂等键；竞态测试覆盖 halt、duplicate ack、finalizer、publisher。
- **Risk: 真实旧数据不可判定 attempted/aborted。** Mitigation: 一律 `unknown_legacy`，不猜；迁移默认 dry-run 且只输出安全计数。
- **Risk: 文档与行为再次漂移。** Mitigation: 项目 Skill/参考文档的契约测试和 PR lifecycle gate同时检查。

## NOT-in-scope

- 修改、修补、复制或重写 `/dev-pipeline` Skill、dev-methodology 规则、hooks 或安装镜像。
- 自动合并、推送、创建 PR、发布 Hugging Face 或执行真实数据迁移。
- 绕过小红书或点点的验证码、频控、登录、安全页或访问限制。
- 新建浏览器 profile、读取/复制 Cookie/Storage、持久化签名链接、使用主浏览器替代 SOP 浏览器。
- 创建每日、开机、常驻后台整理任务。
- 让 Codex/Claude/Gemini 成为一键整理、候选生成或构建必需依赖。
- 猜测或搜索相似 GitHub 项目以填满链接；无法唯一确认就保持候选/待核验。
- 在公开目录、日志、测试报告或对话中输出个人主页、收藏夹 ID、原始评论、OCR 全文、媒体或私有路径。
- 改变收藏夹优先分类、只读采集、安全即停、公开最小化和旧快照可用等批准不变量。
- 未经新的 Spec 审批扩展到其他采集平台、自动安装 Skill、自动执行下载内容或改变现有用户收藏。
- 重做 hero/nav/card 视觉、改变三视图信息架构、品牌/字体系统、生成新 mockup 或引入 UI 框架。
- 把 local overlay、迁移报告、测试 trace 或任何私有状态公开化。

## Success criteria

### Gate A — `implementation_ready` inside this pipeline

- [ ] 所有 BUG-01..BUG-16 有直接 RED/GREEN 回归证明，所有 P1 关闭。
- [ ] 所有 UX-01..UX-14 在真实渲染入口有自动化覆盖，人工只复核视觉/主观体验。
- [ ] 所有 AC-01..AC-15 对应测试、QA 或审计证据齐全。
- [ ] 正式 KB 与公开站对 accepted/current/resource 判断完全一致。
- [ ] 所有合成、公开演示和构建输出中的 confirmed Skill 均恰有一个 verified resource，并同时显示 repo 和 ZIP；validator 对任何真实输入同样 fail closed。
- [ ] 任一失败都显示真实阶段结果；旧快照和已成功核心/逐条结果保留。
- [ ] 安全信号无重试、无回退绕过、无发布。
- [ ] Windows 使用 `npm.cmd`、POSIX/CI 使用 `npm`；release check、Python discovery、ESLint、Playwright、隐私扫描全部通过。
- [ ] review brief 交给用户验收，且尚未自动 PR、push、merge 或 deploy。

### Gate B — `dataset_restored` after the pipeline and a new explicit user action

This is not a deferred implementation item. It is an intentionally separate operational gate because this pipeline is forbidden to read or mutate the user’s real private collection. Step 8 must say plainly that code can be `implementation_ready` while the current private 255-note/56-Skill dataset is not yet proven restored.

- [ ] After brief approval, the user explicitly authorizes a real read-only migration dry-run.
- [ ] The user reviews safe counts/conservation, backup/rollback plan and the exact set of stale/candidate/resource-pending outcomes.
- [ ] The user explicitly authorizes the matching, unexpired `--apply` confirmation; no Agent infers this authority.
- [ ] A dual-output rebuild proves the real KB/public pair shares one build version; local QA verifies status, summaries and confirmed Skill repo/ZIP actions.
- [ ] Publishing is a separate explicit action, runs only when explicitly enabled and not `local_only`, and remains single/non-force; the brief is amended to state `dataset_restored` only after that action succeeds or returns unchanged.

Before Gate B, do not claim that the real user dataset is repaired, that all historical Skills are confirmed, or that a remote publication has been updated.

## Dream-state delta

| Today | Reviewed target |
|---|---|
| Core sync, point transport and curation/resource scripts are three partially disconnected systems | One versioned local-first pipeline with typed handoffs and a single finalizer |
| One broad `completed` state and one fallback summary label hide several realities | Orthogonal, per-dimension state/reason plus exact copy and recovery actions |
| KB/public can apply different trust rules and swap independently | One trust decision and crash-recoverable same-version snapshot pair |
| Keyword similarity can look like a confirmed Skill; detail hides later actions | Candidate remains explicit until exactly one resource is verified; detail renders all safe actions |
| Component tests are green while the user journey is broken | Cross-language contracts, real rendered journeys, restart faults and lifecycle evidence gate the change |

The target deliberately retains human semantic acceptance and an explicit real-data migration gate. “Automatic” means deterministic orchestration and honest pending states, not automatic invention or approval.

## Decision Audit Trail

| Decision | Alternatives considered | Accepted choice and rationale | Scope effect |
|---|---|---|---|
| Recovery strategy | Patch copy/`.find()` only; relax accepted/resource gates; close full chain | Close the full chain. Surface-only fixes score low completeness; relaxing gates violates trust/privacy | HOLD SCOPE |
| Point integration | Change external saver API; adapter around API 1 | Keep API 1 and add trusted private staging/v2 envelope | No external contract break |
| Status reasons | One shared reason; per-dimension reasons | Per-dimension `{status, reason_code, updated_at}` prevents lost simultaneous facts | Existing Spec state semantics clarified |
| Cross-language state contract | Three handwritten enum lists; shared versioned registry + Python reducer | Shared registry for validation/copy; Python remains transition authority | Smaller drift surface |
| Snapshot consistency | Best-effort exception rollback; durable journal/recovery | Durable journal across every swap state and a persistent finalizer CAS | Makes approved dual-output transaction real |
| Resource discovery | GitHub search/similarity; evidence-supplied canonical repo only | Exact repo, allowlisted hosts, no redirect/search/retry; otherwise pending | Preserves no-guessing boundary |
| Empty/all-current runs | Leave implicit; explicit terminal table | Explicit zero-count/all-current behavior avoids stuck `awaiting_plan` | No new feature |
| UI direction | Redesign/mockup; preserve IA and specify behavior | Reuse current tokens/components/IA; add exact state/accessibility contracts | No visual expansion |
| Completion | Treat green code as real dataset recovery; two gates | Separate `implementation_ready` from user-authorized `dataset_restored` | Preserves real-data prohibition |
| Platform commands | Use `npm.cmd` everywhere; OS-specific spelling over common scripts | Cross-platform package scripts with Windows/POSIX command matrix | CI remains executable |
| Accepted revision timing | Restore from a pre-evidence candidate seed; seal after evidence/resource attach | `candidate_seed_revision` proves skeleton idempotency only; accepted passthrough waits for the final sealed `candidate_revision` and all applicable dependencies | Prevents restoring review for a candidate the reviewer never accepted |
| Resource revisions | One revision invalidated by every stars/date refresh; separate identity/currentness revisions | Bind acceptance to `resource_identity_sha256`, track freshness with `verification_snapshot_sha256`; same-identity refresh can preserve acceptance, identity changes require review | Keeps the day-31 gate fail-closed without creating needless semantic re-review |
| Build version derivation | Hash generated files containing their own version; hash a canonical input preimage | Hash the sealed scope, curation generation, public-safe config and builder schema versions before rendering, excluding output/version fields | Removes a self-referential hash and gives both builders one deterministic version |

Every recommended option was auto-accepted in pipeline mode under the approved Spec. The six decision principles used throughout were: complete the approved user outcome, preserve trust/safety, prefer explicit contracts, make behavior directly testable, minimize coupling/reuse existing primitives, and keep every mutation recoverable. No decision creates a new product premise.

## Cross-Phase Themes

- **Truth before optimism:** pending, partial, stale, failed and unchanged are valid outcomes; none is ever renamed success.
- **One identity across stages:** sealed stable IDs, content revisions, finalization key and build version make retries deterministic.
- **Private evidence, minimal projections:** raw material stays private; Node/Bridge/UI exchange only typed, bounded views.
- **Safety is a terminal edge:** the first safety signal has higher priority than fallback, recovery work, build or publish.
- **Reuse before parallel machinery:** extend the bounded runner, KB journal, quality gate, resource action renderer and release scans.
- **Crash recovery is part of correctness:** exception rollback alone is insufficient for the dual-output promise.
- **Every visible state has proof:** contract tests establish data; Playwright establishes the real user entry/action/result.
- **Human boundaries remain explicit:** semantic acceptance, real migration apply, PR, push, merge and deploy never become inferred automation.

## Review Scorecards

### CEO Review

| Dimension | Before | After plan remediation |
|---|---:|---:|
| End-to-end completeness | 7.5 | 9.5 |
| Trust/scope discipline | 9.0 | 9.5 |
| Failure/recovery clarity | 7.0 | 9.3 |
| Testable success definition | 7.5 | 9.2 |
| Overall | 7.8 | 9.3 |

Verdict: `HOLD SCOPE / READY`; initial High 2, Medium 5, Low 1 were folded into the plan. Remaining Critical/High/Medium: 0.

### Design Review

| Dimension | Before | After plan remediation |
|---|---:|---:|
| Information architecture | 8 | 9 |
| Interaction states | 6 | 10 |
| Recovery journey/copy | 7 | 9 |
| Visual-system alignment | 8 | 9 |
| Responsive/accessibility | 6 | 9 |
| Resolved decisions | 6 | 10 |
| Overall | 7.1 | 9.3 |

Verdict: existing IA/tokens/components are the design source of truth; UX-01..14, visible states, focus/live-region/reflow/target-size contracts are assigned. Remaining Critical/High/Medium: 0.

### Engineering Review

| Dimension | Before | After plan remediation |
|---|---:|---:|
| Architecture/recovery | 7.5 | 9.4 |
| Security/trust boundaries | 8.5 | 9.5 |
| Concurrency/idempotency | 7.0 | 9.3 |
| Tests/failure injection | 8.0 | 9.4 |
| Performance/operability | 8.0 | 9.0 |
| Overall | 8.1 | 9.3 |

Verdict: persistent CAS, durable journal recovery, bounded subprocesses and GitHub network policy close every load-bearing finding. Critical failure gaps: 0; remaining Critical/High/Medium: 0.

### Developer Experience Review

| Dimension | Before | After plan remediation |
|---|---:|---:|
| Setup | 7 | 9 |
| Discovery | 6 | 9 |
| First trusted success | 7 | 9 |
| Test loop | 8 | 9 |
| Errors/debugging | 7 | 9 |
| CI/artifacts | 6 | 9 |
| Cross-platform | 6 | 9 |
| Overall | 7.0 | 9.0 |

Verdict: command matrix, focused entrypoint, fixture lifecycle, typed failures and safe artifacts are assigned. Target time to first trusted focused green: <=5 minutes warm, <=15 minutes cold. Remaining Critical/High/Medium: 0.

## Review execution audit

- Review order: CEO → Design → Engineering → Developer Experience; no phase ran in parallel with another review phase.
- Independent voices: one read-only independent reviewer per phase; their recommended findings were reconciled against actual code and folded into this canonical plan.
- Actual-code evidence included Bridge state/finalizer/bounded subprocess paths, both builders and KB journal, publisher, curation primitives, local Bridge validation, detail action rendering, CSS breakpoints/a11y and existing tests.
- External `~/.gstack` artifact/log write: `DEGRADED_TO_PLAN`. The workspace authorization did not include the external user configuration directory, so no attempt was made to bypass permissions. All mandatory review artifacts are embedded here.
- Final gate: pipeline-selected Recommended option A — approve the reviewed plan and continue to Step 4 TDD. This is implementation authorization already supplied by the user; it is not PR/push/merge/deploy or real migration authorization.
- Deferrals/TODOs created: 0. Spec items unassigned: 0. Unresolved decisions: 0.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/autoplan` full-depth | Scope, strategy, completeness and success gates | 1 | PASS | 2 High, 5 Medium, 1 Low found; all folded; 0 unresolved |
| Design Review | UI scope detected | UX-01..14, visible states, responsive and accessibility | 1 | PASS | 3 High, 3 Medium, 1 Low found; all folded; 0 unresolved |
| Engineering Review | Required | Architecture, crash recovery, security, concurrency and tests | 1 | PASS | 4 High, 4 Medium found; all folded; 0 critical gaps; 0 unresolved |
| Developer Experience Review | Developer-facing scope detected | Commands, fixtures, CI artifacts, docs and cross-platform loop | 1 | PASS | 1 High, 5 Medium, 2 Low found; all folded; 0 unresolved |
| Spec Coverage Pre-flight | `/dev-pipeline` Step 3 | Prevent unassigned or silently deferred approved scope | 1 | PASS | 176 unique checklist IDs; 0 unassigned; 0 deferred |

VERDICT: PASS — proceed to `/dev-pipeline` Step 4 TDD. External gstack artifact logging degraded to the canonical plan because external write authorization was unavailable. No production code, tests, approved Spec, pipeline Skill or methodology rule was modified during this review.

NO UNRESOLVED DECISIONS
