# 收藏深度整理与发布标准

本标准是 FavSense 的逐篇策展契约。采集成功不等于整理合格；只有通过本地质量门的条目才能进入知识卡和公开网页。

## 1. 冻结本轮范围

1. “新收藏”不得按原帖发布日期判断。原帖可能发布数月后才被用户收藏；`published_at` 只表示内容发布时间。
2. 常规增量以“上一次已发布知识快照中的稳定笔记 ID”为基线，与当前 catalog 做差集，写入私有 `curation-scope.json`。这是可以审计且不会误删旧卡片的标准口径。
3. `first_seen_at` 只表示 FavSense 第一次发现该条目；首次接入或历史回溯会让大量旧收藏拥有相近时间，因此不能冒充小红书真实收藏时间。
4. 只有平台明确提供并经测试可靠的收藏时间字段时，才能按真实收藏日期筛选；字段缺失时必须向用户说明，不能拿 `published_at` 替代。
5. 以稳定笔记 ID 去重。同一条目属于多个收藏夹时保留全部来源。
6. 每轮开始重新同步收藏夹名称和新增收藏夹；收藏夹名称是默认主分类来源。

建立发布基线与本轮差集：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\prepare-curation-scope.mjs" `
  --catalog ".\.xhs-favorites\catalog.json" `
  --baseline-knowledge "<上一次已发布快照>\data\knowledge.json" `
  --baseline-output ".\.xhs-favorites\published-baseline.json" `
  --include-run-report ".\.xhs-favorites\diandian-rerun-report.json" `
  --run-only true `
  --scope-output ".\.xhs-favorites\curation-scope.json"
```

`--include-run-report` 仅在显式重跑某一批既有收藏时使用：它会把该私有运行报告中的成功与待补证笔记重新纳入范围，而不依赖发布日期，也不改变收藏夹开关。配合 `--run-only true` 时，本轮质量门只审核这次明确重跑的集合；普通增量轮次省略这两个参数，继续使用发布基线差集。

## 2. 逐篇建立证据包

对每篇笔记先检查公开元数据与匿名评论，再按媒体类型补齐正文证据。原始视频、帧、图片和评论文本只能留在私有目录，不得进入 Git、公开 JSON 或报告。

### 点点 AI 正文证据

1. 点点 AI 仅是正文证据来源之一，不是自动通过质量门的策展结论；评论检查、实体识别和官方资源核验仍须独立完成。
2. 只接受通过固定流程附着到当前笔记、发送精确提示词“总结”、并从本轮新完成助手消息中提取的回复。
3. 链接没有被点点识别成笔记卡片时记录 `link-not-recognized`，转入音频转写、按需 OCR 与评论证据回退；不得把它误称为“笔记附件不受支持”，也不得把标题、简介或旧回复冒充点点结果。
4. 每份私有点点记录必须按稳定笔记 ID 保存，并在审计中记录该回复正文的 SHA-256。重新生成或覆盖回复后，旧审计立即失效并回到 `pending`。
5. 只有正式 curation 可发布、审计完整为 `accepted`、且审计哈希与当前回复完全一致时，点点正文才可进入公开页面。

### 视频

1. 先离线转写完整音频；长视频按窗口继续，不能把截断转写标成完整。
2. 阅读转写后列出仍缺失的事实，例如实体名、Skill 名称、`owner/repo`、步骤或关键参数。
3. 只有存在缺失事实时才检查低密度画面或转场 OCR。
4. 找到缺失事实后立即停止视觉检查，转入官方来源核验。
5. 低密度画面仍不能补齐时，只对相关短时间窗按 0.5 秒抽帧；禁止默认全片密集抽帧。

### 图文

1. 标题、标签和短简介只能作为线索，不能代替图片正文。
2. 必须完成图片文字提取或人工复核后才可标记为 `accepted`；审计方法分别写为 `image_ocr` 或 `image_review`。
3. 图片不可用时标记为 `pending` 并说明缺少 `image-text`；不得用常识补写内容。

### 评论

1. 每篇都记录评论是否已检查，即使结果为 0 条。
2. 评论只作为补充线索，不能单独证明产品能力、价格、Star 或兼容性。
3. 不保留评论者身份，公开站点不输出评论原文。

## 3. 写一篇一总结

每条策展至少包含 `title`、`summary`、`action`、`themes`、`tools` 和 `kind`：

- `summary` 写清对象、解决的问题、工作方式和限制；禁止“这篇介绍了……”式空摘要。
- `action` 必须针对该笔记给出具体核验、试用或应用方法；禁止重复模板句。
- 原帖观点、评论线索、系统推断和官方事实必须分开判断。
- 数字、能力、兼容性和实体名称必须能回溯到证据或官方来源。
- 不确定的信息写入私有审计的 `unresolved_facts`，该条保持 `pending`，不对外发布。

## 4. 分类与内容形态

1. 主分类默认采用来源收藏夹或其领域映射。
2. 内容明显不属于原收藏夹时可设置 `category_override: true`，并填写具体 `category_reason`。
3. `kind` 只描述内容形态，不表示处理状态。软件领域可用 `Note / Tool / Skill / Workflow / Product`，其他领域使用自己的 domain profile。
4. 不能因为标题含有 Skill、GitHub、Agent 等词就判为 `Skill`。

## 5. 资源与 GitHub 核验

只要 `tools` 非空，就逐项执行：

1. 从内容证据识别精确名称，不用相似名称替代。
2. 打开官方网站或官方 GitHub 仓库核对归属。
3. GitHub 资源记录 canonical `owner/repo`、仓库链接、默认分支 ZIP、许可证、核验日期和当日 Star。
4. `Skill` 还必须确认仓库中确有可安装的 Skill 结构或 `SKILL.md`，并记录 manifest 路径；普通代码库、插件、提示词或托管产品不能标为 `Skill`。
5. 找不到唯一官方来源时保留 `pending`，不创建猜测链接。

## 6. 私有审计记录

审计文件默认位于 `.xhs-favorites/curation-audit.json`，只保存状态与方法，不保存原始证据。每篇记录：

```json
{
  "status": "accepted",
  "reviewed_at": "2026-08-04",
  "evidence_methods": ["description", "comments", "audio_transcript", "official_source"],
  "comments_checked": true,
  "claims_supported": true,
  "resource_status": "verified",
  "unresolved_facts": []
}
```

使用点点正文时，`evidence_methods` 必须包含 `diandian_summary`，并额外写入 `diandian_summary_sha256`；其值必须是当前私有点点回复正文的 64 位小写十六进制 SHA-256。仅写 `status: accepted` 不足以发布该回复。

状态只有：

- `accepted`：证据与资源核验均满足本标准，可以发布；
- `pending`：缺少正文、实体、仓库或其他关键证据；收藏仍以原始公开摘要留在本地界面，但不得使用候选深度总结或未经核验的资源结论；
- `rejected`：不在范围、重复、用户排除或不应进入知识库。

候选摘要不能直接视为完成。先生成私有复核队列，逐篇阅读 `public_text`、`transcript_text` 或图文证据，并清除所有 blocker 后才能写 `accepted`：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\prepare-curation-review.mjs" `
  --catalog ".\.xhs-favorites\catalog.json" `
  --scope ".\.xhs-favorites\curation-scope.json" `
  --candidates ".\.xhs-favorites\curation-candidates.json" `
  --resources ".\skills\xhs-favorites-organizer\references\software-resources.json" `
  --evidence-root ".\.xhs-favorites\video-analysis" `
  --diandian-dir ".\.xhs-favorites\diandian-summaries" `
  --supplemental-review ".\.xhs-favorites\diandian-fallback-review.json" `
  --output ".\.xhs-favorites\curation-review.json"
```

该命令只准备证据包和 blocker，不会自动把候选标记为合格；禁止把结构检查等同于语义复核。

逐篇语义复核完成后，用受约束的合并器写回候选、审计和正式 curation；它会拒绝重复、越界、私密来源数据和缺字段，并且只把 `accepted` 项写入公开策展源：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\merge-curation-results.mjs" `
  --catalog ".\.xhs-favorites\catalog.json" `
  --config ".\config\xhs-favorites.json" `
  --scope ".\.xhs-favorites\curation-scope.json" `
  --review ".\.xhs-favorites\diandian-fallback-review.json" `
  --candidates ".\.xhs-favorites\curation-candidates.json" `
  --resources ".\skills\xhs-favorites-organizer\references\software-resources.json" `
  --audit ".\.xhs-favorites\curation-audit.json" `
  --curation ".\skills\xhs-favorites-organizer\references\skills-board-curation.json" `
  --expected-count 12
```

## 7. 运行质量门

```powershell
node ".\skills\xhs-favorites-organizer\scripts\validate-curation.mjs" `
  --catalog ".\.xhs-favorites\catalog.json" `
  --config ".\config\xhs-favorites.json" `
  --curation ".\skills\xhs-favorites-organizer\references\skills-board-curation.json" `
  --resources ".\skills\xhs-favorites-organizer\references\software-resources.json" `
  --audit ".\.xhs-favorites\curation-audit.json" `
  --scope ".\.xhs-favorites\curation-scope.json" `
  --report ".\.xhs-favorites\curation-quality-report.json"
```

质量门检查范围完整性、证据方法、评论检查、摘要与具体用法、分类覆盖理由、资源关联，以及 Skill 的仓库/许可证/manifest。`pending` 可以存在，但不会进入发布结果；任何伪造、缺审计却写入策展、或不合格的 `accepted` 都会使命令失败。

## 8. 构建与验收顺序

1. 先运行质量门并阅读报告。
2. 只把 `accepted` 条目写入正式 curation；`pending` 只留在私有审计。所有已同步收藏仍以安全 fallback 显示，质量门只控制深度策展字段，不删除收藏。
3. 构建 Obsidian 与网页，检查新增卡片数等于本轮 `accepted` 数。
4. 检查公开 JSON 不含原始评论、Cookie、Token、个人主页、收藏夹 ID、视频或帧路径。
5. 运行项目测试与发布检查；失败时保留上一个可用站点，不发布半成品。
