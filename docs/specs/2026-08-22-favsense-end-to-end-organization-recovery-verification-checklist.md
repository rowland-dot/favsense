# FavSense 收藏整理端到端闭环验证清单

> 状态：由 APPROVED Spec 派生，供 `/dev-pipeline` TDD、Review、QA、Audit 和 review brief 共同引用。
>
> Governing Spec：`docs/specs/2026-08-22-favsense-end-to-end-organization-recovery-spec.md`
>
> Implementation Plan：`docs/plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md`

## 使用规则

- 每个检查项 ID 稳定且唯一；测试、QA 报告、review finding 和 brief 必须引用 ID，不能只写“已检查”。
- 自动化项必须附命令、退出码和关键断言；人工项必须附 Entry → Action → Expected Result。
- 功能行为不得以 `.todo()`、存在性断言或静态最终态替代真实状态转换。
- `manual-only` 只允许 `[manual-only: visual-polish]` 或 `[manual-only: subjective-ux]`；本清单所有功能性交互均要求自动浏览器覆盖。
- 不在证据中包含私有 ID、Cookie、Token、临时 URL、原始评论、OCR 全文、媒体或私有绝对路径。
- 任一 P0/P1 finding、敏感数据 finding、未分配 Spec 项或失败的安全门都会阻止 brief 通过。

## A. 治理与范围

- [ ] **VC-GOV-01 — Approved Spec gate**：行为变更 PR 必须链接状态为 APPROVED 的 governing Spec；缺失或 DRAFT 时 CI 失败。`TP-001`; Spec §14.1。
- [ ] **VC-GOV-02 — Plan gate**：PR 链接从该 Spec 派生的 canonical `docs/plans/*-plan.md`，并能从计划定位 Spec。`TP-001`; Spec §14.2。
- [ ] **VC-GOV-03 — TDD evidence gate**：PR 链接 RED/GREEN/REFACTOR 证据；至少一个 RED 失败必须精确对应目标缺陷，GREEN 使用同一断言。`TP-001`; Spec §11/§14.3。
- [ ] **VC-GOV-04 — Review gate**：PR 链接 review 报告，P0/P1 为零或有已验证修复。`TP-001`; Spec §14.4。
- [ ] **VC-GOV-05 — QA gate**：PR 链接真实入口 QA 报告，不能只引用单元测试。`TP-001/013`; Spec §14.5。
- [ ] **VC-GOV-06 — Audit gate**：PR 链接 coverage/release/privacy 审计，完整命令退出码为 0。`TP-001/011/014`; Spec §14.6。
- [ ] **VC-GOV-07 — Human gate**：review brief 明确等待用户验证；未获用户批准前不创建 PR。Spec §14.7/§16。
- [ ] **VC-GOV-08 — PR/ship boundary**：没有自动 push、merge、deploy；PR、合并和部署分别需要后续授权。Spec §13.2/§14.8/§16。
- [ ] **VC-GOV-09 — Pipeline integrity**：HOW、PLAN、TDD、Review、QA、Audit、Brief 均运行且没有被删除、静默或绕过。
- [ ] **VC-GOV-10 — Pipeline Skill immutability**：diff 不包含 `/dev-pipeline` Skill、dev-methodology 规则、hooks 或安装镜像。

## B. 用户触发、范围与安全预检

- [ ] **VC-UX-01 — 一次用户动作只启动一次运行**：Entry 本地工作台；Action 点击“一键整理”；Expected 产生一个 run、一个冻结范围，重复快速点击不会产生第二个运行。`UX-01`, `TP-008/013`。
- [ ] **VC-SAFE-01 — Loopback/Origin/Host/Token**：非法 Host、非工作台 Origin、缺少或错误 token、超限 body 均在采集前拒绝；响应无敏感详情。`AC-13`。
- [ ] **VC-SAFE-02 — SOP browser ownership**：只复用 SOP 扫描浏览器和动态端点；不创建第二 profile、不猜端口、不借用主浏览器。
- [ ] **VC-SAFE-03 — Frozen board/note scope**：触发时先冻结请求的 board IDs/mode/local-only target/config digest；发现合并改名/新增且所有指定 board 提交稳定 ID 后，再原子 seal 去重 note IDs。封存后新增看板/笔记不加入；不可用/关闭的指定看板在 note seal 前使本轮失败而不扩大范围。
- [ ] **VC-SAFE-04 — Stable ID deduplication**：同一稳定 note ID 多看板只保留一条核心记录和全部来源；重复扫描不新增副本。
- [ ] **VC-SAFE-05 — Read-only platform actions**：代码路径和 QA 网络记录没有点赞、评论、发布、取消收藏或平台写请求。
- [ ] **VC-SAFE-06 — Safety first signal**：Entry 正在扫描/点点/媒体准备；Action fixture 返回验证码、频控或 `300031`；Expected 首次即 `safety_stopped`，无后续条目、回退、重试或发布。`UX-13`, `AC-12`, `TP-008/009/013`。
- [ ] **VC-UX-13 — Safety stop guidance**：Entry 本地运行面板；Action 任一阶段首次收到验证码、频控或 `300031`；Expected 立即显示安全停止与人工恢复指引，不出现自动重试、回退或发布成功文案。`UX-13`, `AC-12`, `TP-008/009/013`。
- [ ] **VC-SAFE-07 — Untrusted content isolation**：标题、正文、评论、点点、OCR、外部网页中的命令式文字只作为数据，不改变命令、路径、提示词或资源目标。

## C. 核心目录与内容版本

- [ ] **VC-CORE-01 — Atomic catalog update**：详情/匿名评论写入 staging 后原子交换；异常恢复原 catalog 字节。`AC-11`, `TP-008`。
- [ ] **VC-CORE-02 — Existing success preserved**：后续详情或构建失败不删除已成功核心记录、已保存点点或先前 accepted curation。
- [ ] **VC-CORE-03 — Revision-boundary determinism**：相同规范化正文事实产生同一 `content_sha256`；匿名评论、评论检查状态和证据方法不进入该哈希，时间、计数、来源 ID 或 URL 变化也不改变；可信正文变化会改变。规范化评论和实际方法结果连同当前正文哈希产生独立 `evidence_sha256`，等价排列稳定；每个方法依赖精确绑定 `{method, provider, version, result_sha256}`，评论/方法/版本/结果变化只改变证据与审核状态，不改变正文哈希。
- [ ] **VC-CORE-04 — No private hash input in public**：content hash 可以公开作为版本标识时只输出 hash，不输出其原始私有输入；默认公共 JSON 不暴露私有 ID/评论。
- [ ] **VC-CORE-05 — Anonymous comment contract**：核心记录最多保存 30 条匿名评论，去除昵称/账号并标注“未经核实的补充线索”；原始评论文本不得进入 public JSON。
- [ ] **VC-UX-02 — Core completion copy**：Entry 运行面板；Action 核心事务完成但总结/审核未结束；Expected 显示“核心收藏已保存”，不声称总结、知识库、网页或发布全部完成。`UX-02`, `TP-002/013`。

## D. 点点计划、逐条保存和恢复

- [ ] **VC-SUM-01 — Current record skip**：正文哈希、provider、prompt version、清理后 reply 的 `summary_sha256` 和记录格式均匹配时计划跳过该条；`request_sha256` 只用于保存请求幂等，不替代总结结果哈希。`AC-08`, `TP-003`。
- [ ] **VC-SUM-02 — Stale record reschedule**：正文专用哈希、provider、prompt version 或总结结果变化，或旧记录无可证明正文/总结哈希时进入 `stale` 并重新纳入点点计划；仅评论或其他非点点方法证据变化不得重抓点点，只使 curation stale 并重审；旧文件保留为历史证据。`UX-14`, `TP-003/004`。
- [ ] **VC-SUM-03 — Atomic single-note save**：外部 saver API 1 只写私有 transaction-shaped staging；Bridge 从 current catalog 和已验证 Skill 合同派生 `content_sha256`/provider/`prompt_version`，从清理后实际持久化 reply 计算 `summary_sha256`，组装完整 v2 后才单次原子替换 live 并改为 `captured`。Payload 不能提供这些 revision 字段；任一失败保留旧 live 字节。
- [ ] **VC-UX-03 — Immediate captured visibility**：Entry 总结进度；Action 一篇成功；Expected 该篇立即显示 `captured`，后续条目失败不回滚。`UX-03`, `TP-003/008`。
- [ ] **VC-UX-04 — Failed vs batch_aborted**：Entry 三条计划；Action 第二条 transport failure；Expected 第二条 `failed`，第三条 `batch_aborted`，二者 reason/status 可区分。`UX-04`, `AC-07`, `TP-002/009`。
- [ ] **VC-SUM-04 — One link/one prompt**：每篇临时签名链接只提交一次，固定提示词只发送一次，只读取本轮新完成助手消息。
- [ ] **VC-SUM-05 — Failed page retained**：点点失败保留失败页面并停止当前批次；已成功页面按契约关闭，不误关失败页。
- [ ] **VC-UX-12 — Idempotent resume**：Entry 再次运行；Action 启动同 scope；Expected 仅处理 failed、batch_aborted、stale 或显式选择项，current captured/accepted 跳过。`UX-12`, `AC-08`, `TP-002/003/009/010`。

## E. 安全回退与证据归一化

- [ ] **VC-EVD-01 — Public text/comments evidence**：实际存在的公开文字和匿名评论检查状态进入 evidence packet；未检查不能写成 checked；packet 同时绑定当前 `content_sha256`、由规范化评论/实际方法结果计算的 `evidence_sha256`，以及每种实际方法的精确 `{method, provider, version, result_sha256}` 依赖；缺 key、多余 key 或版本/结果不匹配均 fail closed。
- [ ] **VC-EVD-02 — Cached video audio first**：只有已缓存、已启用且无安全信号的视频才调用本地转写；先音频、按缺失事实决定视觉升级。
- [ ] **VC-EVD-03 — Image OCR producer**：只有已缓存图片和显式配置的本地 OCR 引擎才生成私有 `image-ocr.json`；无工具时 `evidence_status=missing`、`curation_status=pending_review`、`reason_code=ocr_unavailable|evidence_missing`。
- [ ] **VC-EVD-04 — No automatic dense frames**：未列出 missing facts 不抽帧；稀疏证据已补齐即停止；密集帧仅限短相关窗口。
- [ ] **VC-EVD-05 — Safety suppresses fallback**：安全信号发生后不调用音频、OCR、帧、GitHub 或其他替代通道。`AC-12`。
- [ ] **VC-EVD-06 — Honest missing evidence**：没有足够证据时 `evidence_status=missing|blocked` 且 reason 为 `evidence_missing`/具体安全原因，不补写摘要或工具。
- [ ] **VC-EVD-07 — Evidence packet privacy**：正式/公开输出只含方法标签、hash、可支持声明和 unresolved facts；不含评论原文、OCR 全文、媒体路径或临时 URL。`AC-13`, `TP-009/011`。

## F. 候选、审核和 accepted 门

- [ ] **VC-CUR-01 — Candidate producer exists**：scope 内每条笔记都有候选或精确 blocker；不存在依赖手工预建 `curation-candidates.json` 的断链。`BUG-02`, `AC-01`。
- [ ] **VC-CUR-02 — Deterministic repeat**：同输入重复运行候选/证据/审核编排，除允许时间字段外语义相同，ID 和数量不增加。
- [ ] **VC-CUR-03 — No-Agent core**：删除/禁用所有模型和 Agent 配置后，scope、candidate、pending audit、build 和安全状态仍可完成。`AC-15`, `TP-016`。
- [ ] **VC-CUR-04 — Pending is not accepted**：缺评论、正文、实体、资源、hash、claims 或 unresolved facts 任一项时不进入正式 curation/KB/public。
- [ ] **VC-CUR-05 — Accepted current hash**：只有 accepted audit、当前 curation revision、当前 content/evidence hash、证据方法依赖和最终 sealed `candidate_revision` 全部匹配才正式采用；使用点点时还必须匹配 provider/prompt/`summary_sha256`，声明资源时还必须匹配稳定 ID/`resource_identity_sha256`，不适用的依赖不得伪造。`AC-02`。
- [ ] **VC-CUR-06 — Existing accepted preservation**：正文、evidence、最终 candidate、curation 和所有适用依赖匹配的 existing accepted 才保留；正文或点点 provider/prompt/结果变化使点点与审核 stale，其他证据变化只使审核 stale。资源 identity 变化使审核 stale；stars/date/default-branch 的同 identity snapshot 刷新可恢复原 accepted，但第 31 个 UTC 日历日起刷新成功前不能满足 confirmed Skill 门。所有情况都保留历史。
- [ ] **VC-CUR-07 — Ordered crash-recoverable pipeline state**：严格执行 scope → initialize hash-bound audit placeholders → candidate seed → attach normalized evidence → closed resource assessment → seal final candidate revision → configured review（未配置时生成 pending）→ status-aware merge → validate。初始化不预先声称证据/评论已检查，accepted 不能从 placeholder 或 seed 恢复；merge 前必须形成与 sealed scope 精确一对一的 review set：当前 accepted 仅在 final seal 与全部适用依赖匹配后原样 passthrough；配置了 review adapter 时仅覆盖其余精确 ID，未配置时只生成 pending；任何重复/遗漏/越界都失败。pending/rejected 可保留有界私有 skeleton 但不能进入 formal curation；accepted 仍强制完整契约。全部 staging 验证后通过 participant-aware 持久 journal 同代切换 candidates、私有 resource assessments、formal resource registry、audit 和 curation，对每个 participant backup/swap 边界做 fault injection；进程崩溃后先恢复为完整旧代或新代才能构建，不暴露混合代。失败事务只在私有 quarantine 保留安全 manifest。
- [ ] **VC-CUR-08 — Dead summary input removed**：Bridge 不再传入构建器未消费的 `--summaries`；正式来源有唯一可测试契约。`BUG-03`。
- [ ] **VC-CUR-09 — Versioned subprocess result**：Bridge 只接受 curation/snapshot CLI 的单一、精确白名单 JSON envelope；非法 JSON、多余 key、超限输出、超时、非 0 exit、路径或私密值均 fail closed，且不调用下一阶段。`TP-004/008`。

## G. Skill 与 GitHub 资源

- [ ] **VC-RES-01 — Candidate is not confirmed**：未 accepted 或资源不完整时 confirmed `kind` 使用领域安全默认（无匹配时为 `Other`）；仅当确定性候选分类器返回 `Skill` 但公开 Skill 门未满足时才输出 `candidateKind=Skill`，否则省略该字段，且不能公开标记 Skill。`BUG-04/16`, `TP-005/006`。
- [ ] **VC-RES-02 — Exactly one resource**：每个公开 confirmed Skill 恰好关联一个稳定 verified resource ID；0 或 >1 都不合格。`AC-04`。
- [ ] **VC-RES-03 — Canonical repo**：resource 含唯一规范化 `owner/repo` 和匹配的官方 HTTPS repo；相似名称不能替代。
- [ ] **VC-RES-04 — Safe download**：resource 含默认分支 ZIP 或核验 release 下载；URL 与 canonical repo 同 owner/repo，HTTPS 且通过安全 URL 过滤。
- [ ] **VC-RES-05 — Complete metadata**：confirmed Skill resource 具有 license、唯一 Skill manifest path、verified date、stars snapshot、explicit compatibility、官方 compatibility evidence locator、`resource_identity_sha256` 和 `verification_snapshot_sha256`；assessment 使用精确 key schema，缺失/多余 key 均 fail closed。`AC-05`。
- [ ] **VC-RES-06 — Freshness**：`resource_index.verification_max_age_days=30`；严格解析真实 `YYYY-MM-DD` 并以注入 UTC 日期做 Gregorian 日历日运算，合法 `verified_at` 年龄 0..30 天（含第 30 天）为 fresh，第 31 天、非法日期或未来日期为 `stale`，并从 confirmed Skill 资格中移除；跨月/年/闰日和非 UTC 进程时区结果一致。验证器、双构建器和迁移共用同一函数/配置，不能静默沿用或另设默认值；同 identity refresh 只更新 snapshot revision，identity 变化必须重审。
- [ ] **VC-RES-07 — No GitHub search guessing**：自动核验只请求证据中明确 canonical repo 的官方端点；不调用搜索、不尝试相似 owner/repo、不自动重试 403/429。
- [ ] **VC-RES-08 — Registry migration honesty**：无法补齐的旧条目标记 candidate/stale；不伪造 license、manifest、stars、compatibility 或 revision。pending/stale assessment 只持久化在私有资源状态；完整 verified snapshot 才进入 formal registry，且与 candidates/audit/curation 同一事务代。
- [ ] **VC-UX-08 — Public Skill resource access**：Entry 公开 Skill 卡；Action 打开详情；Expected 存在唯一 verified resource；无资源卡不显示为 Skill。`UX-08`, `TP-005/013`。
- [ ] **VC-UX-09 — Repo and ZIP both visible**：Entry confirmed Skill 详情；Action 查看相关资源；Expected 官方仓库、ZIP 及其他安全动作全部显示，不只第一个。`UX-09`, `AC-06`, `TP-013`。

## H. 正式输出、私有 overlay 与 UI 状态

- [ ] **VC-OUT-01 — KB/public same decision**：同一夹具在私有正式 KB 和 public builder 上得到相同 accepted/current/resource 判断。`BUG-12`, `AC-02`。
- [ ] **VC-OUT-02 — Raw point stays private**：pending/stale/legacy 点点不进入正式 Markdown 或公开 JSON；只可经鉴权 loopback overlay 本机查看。
- [ ] **VC-OUT-03 — Accepted point provenance**：accepted/current 点点显示来源、审核日期、证据标签；不输出 prompt 页面、临时链接或原回复外的私密字段。
- [ ] **VC-OUT-04 — Skill outcome file**：`05-Skills成果/GitHub-Skills核验清单.md` 对每个 confirmed Skill记录项目名、类型、repo、ZIP、license、manifest、stars/date、compatibility、状态；候选明确未核实。
- [ ] **VC-OUT-05 — Public minimized fields**：public JSON 通过 schema 和敏感扫描；无个人主页、收藏夹 ID、token、xsec、原始评论、媒体、帧、OCR 或 `.local`。
- [ ] **VC-UX-05 — Local pending overlay**：Entry 本地详情；Action 打开 captured but not accepted 笔记；Expected 私有“待审核证据”区域显示点点内容与 blocker，且不冒充正式总结。`UX-05`, `AC-03`, `TP-008/013`。
- [ ] **VC-UX-06 — Public pending note**：Entry 公开详情；Action 打开未 accepted 笔记；Expected 安全元数据兜底 + 精确状态，不显示私有证据。`UX-06`, `TP-006/013`。
- [ ] **VC-UX-07 — Accepted point note**：Entry 公开详情；Action 打开 accepted/current 点点笔记；Expected 点点总结、来源、审核时间和证据标签完整。`UX-07`, `TP-006/013`。
- [ ] **VC-UI-01 — Authenticated overlay route**：非 manager origin、无 token、错误 token、非法 note ID 都不能获得 overlay；响应白名单键和值长度受限。
- [ ] **VC-UI-02 — Resource link accessibility**：所有动作可 Tab 聚焦，名称可区分，不依赖只读图标；新窗口链接带 `rel=noreferrer`。
- [ ] **VC-UI-03 — Live status accessibility**：运行状态和 overlay loading/result 使用可读 live region；更新不移动焦点或锁死对话框。
- [ ] **VC-UI-04 — Keyboard dialog arc**：键盘可打开详情、遍历 repo/ZIP/关闭按钮并关闭；焦点与滚动位置恢复。
- [ ] **VC-UI-05 — Dynamic domain vocabulary**：筛选/标签继续来自 `meta.kindLabels`；软件 candidate 逻辑不泄漏到 fitness/skincare。
- [ ] **VC-UI-06 — Safe URL filtering**：`javascript:`, 非允许协议、错误 GitHub owner/repo 和 `#` 动作不渲染为可点击链接。

## I. 构建、发布与状态真实性

- [ ] **VC-BLD-01 — No early formal build/publish**：最后一块 core 后在 summary/curation gate 未确定前，formal build/publish 计数均为 0。`AC-09`。
- [ ] **VC-BLD-02 — One build version**：在渲染前对 sealed scope、完整 curation generation、公开安全配置和双 builder schema version 的 canonical preimage 计算唯一 build version；preimage 排除生成字节、时间戳和嵌入的 `buildVersion`，避免自引用。一次 run 的 KB/public/publish 嵌入同一值；重复回调不创建第二版。
- [ ] **VC-BLD-03 — At most one publish**：最终 accepted snapshot 构建成功后，仅当本轮配置显式启用发布且不是 `local_only` 时 publish 最多 1 次；否则为 0。`AC-09`。
- [ ] **VC-BLD-04 — Build rollback**：构建任一阶段失败恢复同版本旧 KB/public snapshot，publish 不调用，状态 `build.status=failed`、`build.artifact_status=held_previous`、`reason_code=build_failed`。`AC-11`。
- [ ] **VC-BLD-05 — Publish rollback**：publish 失败保留本地新 build 和远端旧版，状态 `publish.status=failed`、`publish.artifact_status=held_previous`、`reason_code=publish_failed`，不 force push。`AC-11`。
- [ ] **VC-UX-10 — Build failure copy**：Entry 运行结果；Action final build fixture 失败；Expected 显示构建失败和旧快照保留，绝不显示“网页已经更新”。`UX-10`, `AC-10`, `TP-007/008/013`。
- [ ] **VC-UX-11 — Publish failure copy**：Entry 运行结果；Action publisher fixture 失败；Expected 显示发布失败、远端仍为上版、本地核心/构建结果状态。`UX-11`, `AC-10`, `TP-008/013`。
- [ ] **VC-BLD-06 — Full-success copy gate**：只有 core success、summary 无未报告项、curation validated、两份 build success、publish published/unchanged（若启用）、version 一致时显示完整成功。
- [ ] **VC-BLD-07 — Unchanged publish**：远端内容相同返回 `unchanged`，UI 明确“内容无变化”，不伪造新发布。
- [ ] **VC-BLD-08 — Single swap owner**：KB/public builder 的 library mode 只生成和验证 staging，不替换 live；`build-organization-snapshot.mjs` 是双输出 journal/swap/rollback 的唯一拥有者。直接 CLI 仍复用同一 library export 并保持旧的单输出行为。`TP-007/008`。

## J. 精确状态和迁移

- [ ] **VC-STATE-01 — Allowed note enums**：六个 note status 维度只接受 Spec §6.1 枚举，包括 resource=`candidate`、public=`not_eligible`；不允许实现自创 `pending`/`metadata_only`/`blocked` 等替代状态，未知值 fail closed。
- [ ] **VC-STATE-02 — Allowed run enums**：run overall state 只由 phase reducer 产生 Spec §6.2 枚举，调用者不能直接声明 full success。
- [ ] **VC-STATE-03 — Safe reason codes**：`site/organization-status-contract.json` 是 Python、Node、browser 共读的唯一版本化公开安全枚举/reason/copy 契约；任一层的手写副本、未知版本或读取失败都 fail closed。状态 API 只输出批准 reason code、安全说明、计数、时间、schema/build version；错误字符串经过清理。
- [ ] **VC-STATE-04 — Legacy mapping**：旧 run `completed` 映射为允许的 `completed_with_warnings` 并附 `reason_code=unknown_legacy`；旧 point/批量 unresolved 映射为允许的 `stale`/安全聚合状态并附该 reason，不把 `unknown_legacy` 发明为状态，也不伪造 confirmed success 或逐条 attempted failure。
- [ ] **VC-STATE-05 — Closed phase enums and reducer priority**：core/summary/evidence/curation/build/publish 只接受计划 `Phase-state v2` 枚举；summary/evidence 的 run-phase `safety_stopped` 与 Spec §6.1 逐笔状态分层，当前笔记仍用允许的 failed/safety reason，剩余未尝试项为 batch_aborted。安全停止优先，双输出事务失败为 failed，任何已报告非完整项保持 organization_partial，只有其余阶段完整而发布失败时才为 completed_with_warnings；调用者不能用自由文本覆盖 reducer。
- [ ] **VC-UX-14 — Stale visible**：Entry 已审核笔记；Action fixture 分别修改正文与只修改评论/方法证据；Expected 前者使旧总结/审核显示“正文已变化，等待重新审核”，后者保留 captured 总结但使审核显示“证据已变化，等待重新审核”；formal output 均回到上个合法状态或安全元数据。`UX-14`, `TP-002/003/004/010`。
- [ ] **VC-MIG-01 — Dry-run default**：迁移不带 `--apply` 时不写 live/backup/public，只生成安全 count plan。
- [ ] **VC-MIG-02 — Conservation**：输入稳定 ID 总数 = unchanged + migrated + pending/rejected；重复项不增加。`AC-14`。
- [ ] **VC-MIG-03 — Guarded apply**：apply 需要匹配 fresh dry-run ID 的显式 confirm；不匹配拒绝且零写入。
- [ ] **VC-MIG-04 — Atomic rollback**：fault injection 在每个写/交换点恢复旧 snapshot；备份和 rollback manifest 均留在私有目录。
- [ ] **VC-MIG-05 — No real apply in pipeline**：TDD/QA 只使用 synthetic fixture；review brief 前未对真实 `.xhs-favorites/` 执行 apply。

## K. 自动化、回归与发布门

- [ ] **VC-AUTO-01 — Lifecycle unit**：`node --test scripts/test-verify-development-lifecycle.mjs` exit 0。
- [ ] **VC-AUTO-02 — Curation/organization contracts**：`node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs` exit 0。
- [ ] **VC-AUTO-03 — Public site**：`npm.cmd run test:site` exit 0。
- [ ] **VC-AUTO-04 — Knowledge base**：`npm.cmd run test:knowledge` exit 0。
- [ ] **VC-AUTO-05 — Bridge/full Python**：`python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"` exit 0。
- [ ] **VC-AUTO-06 — Point Skill Python**：release check 中另一套 `xhs-diandian-summarize-note` Python tests exit 0。
- [ ] **VC-AUTO-07 — Syntax**：`npm.cmd run check:syntax` 对全部 Git 跟踪 `.js/.mjs` 执行当前 Node 语法检查并 exit 0；Python import/compile tests exit 0。`TP-012`。
- [ ] **VC-AUTO-08 — ESLint/a11y**：`npm.cmd run lint:a11y` 对作者编写的浏览器 JS exit 0；命令不得被声称为 imperative `innerHTML` 的行为证明，可访问功能仍由 mounted DOM/Playwright 断言关闭。`TP-012/013`。
- [ ] **VC-AUTO-09 — Playwright**：`npm.cmd run test:e2e` 由单一 Playwright `webServer` 进程执行，每个用例先通过 fixture-only 封闭控制面重置并选择 success/partial/build-failed/publish-failed/safety-stopped，再对 `chromium` 与 `mobile-chromium` 项目运行真实 UI 动作；exit 0 且无意外 console/network errors。`TP-013`。
- [ ] **VC-AUTO-10 — Release check**：`npm.cmd run release:check` exit 0。`TP-014`。
- [ ] **VC-AUTO-11 — Explicit project Python command**：按 AGENTS.md 运行 `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"` exit 0。
- [ ] **VC-AUTO-12 — Privacy/public tree**：`npm.cmd run verify` exit 0；staged diff 人工检查无私有路径/值。
- [ ] **VC-AUTO-13 — Cross-platform/PR gate sequencing**：review brief 前，synthetic PR-event lifecycle tests exit 0，CI workflow 静态配置同时包含 Ubuntu/Windows release-check 与 pull-request lifecycle gate；用户批准创建 PR 后，真实两平台 jobs 必须通过才能进入 merge 讨论。真实 PR CI 不得被伪装成 pre-brief 已执行证据。
- [ ] **VC-AUTO-14 — Repeatability**：候选 pipeline、builders 和 migration dry-run 各运行两次；语义结果和 count 不漂移。同时对 curation/snapshot subprocess parser 重放同一合法/非法 envelope，状态转换和失败边界必须一致。
- [ ] **VC-AUTO-15 — Windows setup safety**：Windows CI 运行 `npm.cmd run test:windows-contracts` exit 0，覆盖 SOP browser ownership、setup rollback、downloader setup 与无计划/开机任务边界。`TP-017`。

## L. QA journeys

- [ ] **VC-QA-01 — Full success**：fixture workbench → click 一键整理 → core saved → point captured → accepted resource → build → published/unchanged；Expected one version/one publish/完整成功文案。
- [ ] **VC-QA-02 — Mid-batch transport failure**：三条计划第二条失败；Expected first preserved, second failed, third batch_aborted, recover action available。
- [ ] **VC-QA-03 — Resume**：从 QA-02 再次触发；Expected first skipped, only second/third处理，计数不重复。
- [ ] **VC-QA-04 — Safety stop**：任意阶段注入 `300031`；Expected immediate stop, no fallback/retry/publish, human guidance visible。
- [ ] **VC-QA-05 — Evidence pending**：point unavailable + no local media/tool；Expected core success + `evidence_status=missing` + `curation_status=pending_review` + 精确 reason，安全元数据可见，无伪造总结。
- [ ] **VC-QA-06 — Local overlay/public isolation**：同一 pending 笔记分别从 local/public 打开；Expected local sees sanitized evidence, public never sees it。
- [ ] **VC-QA-07 — Confirmed Skill**：打开 accepted Skill；Expected project identity, repo, ZIP, license/manifest/date/stars/compatibility and all actions。
- [ ] **VC-QA-08 — Skill candidate**：打开关键词像 Skill 但未核验笔记；Expected candidate label/pending reason, not confirmed Skill, no guessed GitHub link。
- [ ] **VC-QA-09 — Build failure**：final builder fault；Expected old local snapshots byte-preserved, no publish, truthful UI。
- [ ] **VC-QA-10 — Publish failure**：publisher fault；Expected local build success, remote-held-previous, truthful UI。
- [ ] **VC-QA-11 — Stale revisions**：accepted fixture 分别发生正文变化与 evidence-only 变化；Expected 精确 stale/pending reason、旧证据保留、正文变化才重排点点、无 formal misuse。
- [ ] **VC-QA-12 — Migration dry-run**：synthetic old state；Expected safe counts, conservation, no write; fault rollback verified。
- [ ] **VC-QA-13 — Keyboard/accessibility**：keyboard-only run panel/detail/resource actions/close; Expected visible focus, accessible names, live announcements and restored focus。
- [ ] **VC-QA-14 — Responsive readability** `[manual-only: visual-polish]`：desktop/mobile viewport；Expected status, overlay and multi-action layout have no overlap/truncation/hidden required action。Functional presence remains Playwright-automated。`TP-015`。
- [ ] **VC-QA-15 — Message clarity** `[manual-only: subjective-ux]`：review partial/failure/recovery copy；Expected user can distinguish core saved, captured pending, attempted failed, not attempted, build failure and publish failure without reading logs。`TP-015`。

## M. AC closure index

- [ ] **VC-AC-01**：AC-01 — 点点原子保存后自动进入 candidate/audit/build 或明确 pending；状态不丢。`VC-SUM-03`, `VC-CUR-01/07/09`, `TP-003/004`。
- [ ] **VC-AC-02**：AC-02 — 未 accepted/current 不进入 formal output。`VC-CUR-04/05`, `VC-OUT-01/02`, `TP-003/004/007`。
- [ ] **VC-AC-03**：AC-03 — pending overlay 只在 authenticated loopback 可见。`VC-UX-05`, `VC-UI-01`, `TP-008/013`。
- [ ] **VC-AC-04**：AC-04 — 每个公开 Skill 恰有一个 verified resource。`VC-RES-02`, `TP-005/007`。
- [ ] **VC-AC-05**：AC-05 — repo/ZIP/license/manifest/date/compatibility 完整。`VC-RES-03..06`, `TP-005`。
- [ ] **VC-AC-06**：AC-06 — 详情全部安全动作。`VC-UX-09`, `VC-UI-02/06`, `TP-013`。
- [ ] **VC-AC-07**：AC-07 — failed 与 batch_aborted 分开。`VC-UX-04`, `TP-002/009`。
- [ ] **VC-AC-08**：AC-08 — current success skipped, only needed resumes。`VC-SUM-01/02`, `VC-UX-12`, `TP-002/003/009`。
- [ ] **VC-AC-09**：AC-09 — gate 前 publish 0，最终最多 1。`VC-BLD-01/03`, `TP-008`。
- [ ] **VC-AC-10**：AC-10 — finalize/build/publish failure never full success。`VC-UX-10/11`, `VC-BLD-06`, `TP-002/008/013`。
- [ ] **VC-AC-11**：AC-11 — build local rollback, publish remote-held-previous。`VC-BLD-04/05/08`, `TP-007/008/010`。
- [ ] **VC-AC-12**：AC-12 — safety first signal stops, no retry。`VC-SAFE-06`, `VC-EVD-05`, `TP-008/009/013`。
- [ ] **VC-AC-13**：AC-13 — public tree sensitive scan clean。`VC-OUT-05`, `VC-AUTO-12`, `TP-011`。
- [ ] **VC-AC-14**：AC-14 — migration conservation/no duplicate/unknown honest。`VC-MIG-01..04`, `TP-010`。
- [ ] **VC-AC-15**：AC-15 — no model dependency for core/candidate state。`VC-CUR-03`, `TP-016`。

## N. Bug closure index

- [ ] **VC-BUG-01**：BUG-01 — 保留 accepted/hash/resource 门并补齐上游 curation 编排。`VC-CUR-01/04/05/07/09`, `VC-OUT-01`, `TP-004/007`。
- [ ] **VC-BUG-02**：BUG-02 — 确定性 candidate producer 成为生产链步骤。`VC-CUR-01/02`, `TP-004`。
- [ ] **VC-BUG-03**：BUG-03 — 删除未消费 `--summaries`，两份 formal output 共用唯一 trust decision。`VC-CUR-08`, `VC-OUT-01`, `TP-004/007`。
- [ ] **VC-BUG-04**：BUG-04 — 关键词只能产生 candidateKind，confirmed Skill 需要 verified resource。`VC-RES-01/02`, `TP-005/006`。
- [ ] **VC-BUG-05**：BUG-05 — stable resource ID + explicit canonical repo verification；不按名称猜。`VC-RES-03/07`, `TP-005`。
- [ ] **VC-BUG-06**：BUG-06 — detail 遍历全部 safe actions。`VC-UX-09`, `VC-UI-02/06`, `TP-013`。
- [ ] **VC-BUG-07**：BUG-07 — attempted failure 与未尝试 batch abort 使用不同状态。`VC-UX-04`, `VC-AC-07`, `TP-002/009`。
- [ ] **VC-BUG-08**：BUG-08 — safe cached audio/OCR/comment fallback producer/dispatcher。`VC-EVD-01..06`, `TP-009`。
- [ ] **VC-BUG-09**：BUG-09 — final gate 前发布 0、之后最多 1。`VC-BLD-01/03`, `VC-AC-09`, `TP-008`。
- [ ] **VC-BUG-10**：BUG-10 — finalizer/build failure 决定 run state/UI，不能 completed。`VC-UX-10`, `VC-BLD-06`, `TP-002/008/013`。
- [ ] **VC-BUG-11**：BUG-11 — publish failure 显示 remote-held-previous。`VC-UX-11`, `VC-BLD-05`, `TP-008/013`。
- [ ] **VC-BUG-12**：BUG-12 — KB/public accepted/current 语义一致。`VC-OUT-01/02`, `TP-007`。
- [ ] **VC-BUG-13**：BUG-13 — summary status/reason 驱动具体文案，移除统一兜底。`VC-UX-06/07`, `VC-STATE-03`, `TP-006/013`。
- [ ] **VC-BUG-14**：BUG-14 — confirmed Skill 强制完整且 fresh 的 resource schema。`VC-RES-05/06`, `TP-005`。
- [ ] **VC-BUG-15**：BUG-15 — 端到端用户结果进入 Node/Python/Playwright/release gate。`VC-AUTO-02..10`, `TP-004/007/008/013/014`。
- [ ] **VC-BUG-16**：BUG-16 — 更新旧 fallback kind 测试为 candidateKind 合同。`VC-RES-01`, `TP-006`。

## O. Spec section closure index

- [ ] **VC-SPEC-03**：Spec §3 目标、非目标与不可破坏边界由 `VC-GOV-07..10`, `VC-SAFE-01..07`, `VC-CUR-03`, `VC-OUT-05` 以及计划 `NOT-in-scope` 共同闭环；不得以修复为由扩展平台写操作、模型依赖或自动发布范围。
- [ ] **VC-SPEC-04**：Spec §4 术语与可信层级由 `VC-CORE-03`, `VC-SUM-01..03`, `VC-CUR-04..06`, `VC-RES-01..06`, `VC-OUT-01..03` 验证；candidate、captured、accepted、current、confirmed Skill 不得互相替代。
- [ ] **VC-SPEC-05**：Spec §5 端到端阶段 A–J 由 `VC-SAFE-01..07`, `VC-CORE-01..05`, `VC-SUM-01..05`, `VC-EVD-01..07`, `VC-CUR-01..09`, `VC-RES-01..08`, `VC-OUT-01..05`, `VC-BLD-01..08`, `VC-MIG-01..05` 和 `VC-QA-01..12` 按实际发布顺序闭环。
- [ ] **VC-SPEC-06**：Spec §6 状态模型与完成语义由 `VC-STATE-01..05`, `VC-UX-02..05`, `VC-UX-10..12`, `VC-BLD-06` 验证；运行完成态只能由正交 phase reducer 推导。
- [ ] **VC-SPEC-07**：Spec §7 用户可见行为契约由 `VC-UX-01..14`, `VC-UI-01..06`, `VC-QA-01..15` 验证，包含成功、部分失败、未尝试、安全停止、stale、构建失败和发布失败。
- [ ] **VC-SPEC-08**：Spec §8 缺陷审计由 `VC-BUG-01..16` 一一闭环；每项必须关联修复 commit、原始 RED 失败与同断言 GREEN 证据。
- [ ] **VC-SPEC-09**：Spec §9 根因由 `VC-CUR-01/08`, `VC-RES-01/02`, `VC-BLD-01..03`, `VC-STATE-01..05`, `VC-AUTO-01/09/13` 覆盖，分别验证断链、弱不变量、过早发布、状态失真与测试门缺口已消除。
- [ ] **VC-SPEC-10**：Spec §10 分步修复方案由计划 Task 0–11 的 RED → GREEN → REFACTOR/VERIFY → COMMIT 切片执行；`VC-AUTO-01..15` 与 `VC-BRIEF-01..08` 验证没有将批准范围推迟为 TODO。
- [ ] **VC-SPEC-11**：Spec §11 TDD 与验收矩阵由 `TP-001..017`, `VC-AUTO-01..15`, `VC-AC-01..15` 闭环；功能断言不得用存在性检查、静态最终态或 `.todo()` 代替。
- [ ] **VC-SPEC-12**：Spec §12 可观测性与安全日志由 `VC-STATE-03`, `VC-EVD-07`, `VC-OUT-05`, `VC-SAFE-06`, `VC-AUTO-12` 验证；错误可定位但不泄露私有值、路径或证据正文。
- [ ] **VC-SPEC-13**：Spec §13 回滚与发布策略由 `VC-BLD-01..07`, `VC-MIG-01..05`, `VC-GOV-08`, `VC-QA-09/10/12`, `VC-BRIEF-06/07` 验证；代码、数据、构建、远端发布与迁移均有独立回滚边界。
- [ ] **VC-SPEC-14**：Spec §14 永久开发流程治理由 `VC-GOV-01..10`, `VC-AUTO-01/10/12/13`, `VC-BRIEF-01..08` 验证；Spec → Plan → TDD → Review → QA → Audit → Brief → user gate → PR 不可跳步。
- [ ] **VC-SPEC-15**：Spec §15 Definition of Done 仅在 `VC-AC-01..15`, `VC-BUG-01..16`, `VC-UX-01..14`, `VC-AUTO-01..15`, `VC-QA-01..15` 全部有证据且无 P0/P1 finding 时关闭；真实 PR CI 项在用户批准创建 PR 后才从 `not_yet_applicable` 转为必须通过。

## Final review brief gate

- [ ] **VC-BRIEF-01**：brief links Approved Spec, implementation Plan, this checklist, commit list and exact branch/base.
- [ ] **VC-BRIEF-02**：brief lists each BUG-01..BUG-16 with fix commit and RED/GREEN evidence.
- [ ] **VC-BRIEF-03**：brief lists UX-01..UX-14 and AC-01..AC-15 with checklist IDs and QA/test evidence.
- [ ] **VC-BRIEF-04**：brief states full command results and dates; no “passed” claim without exit/output evidence.
- [ ] **VC-BRIEF-05**：brief records remaining P2/P3 or known limitations; no P0/P1 remains.
- [ ] **VC-BRIEF-06**：brief records rollback for code, local snapshot, publish and migration.
- [ ] **VC-BRIEF-07**：brief states real migration apply, PR, push, merge and deploy have not occurred.
- [ ] **VC-BRIEF-08**：user can verify full success, partial failure, Skill repo/ZIP, overlay isolation and stale/recovery from the described entry points.

## Coverage declaration

This checklist assigns every Spec §3–§15 requirement, BUG-01..BUG-16, UX-01..UX-14 and AC-01..AC-15. There are no deferred, manual-only functional or unassigned items.
