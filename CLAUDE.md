# Claude 项目说明

处理小红书收藏同步、整理、知识卡片、面板或网页数据任务前，完整阅读并遵循：

`skills/xhs-favorites-organizer/SKILL.md`

核心运行链路必须保持 Agent 无关。Claude 只能作为可选策展层编辑结构化 curation JSON，然后运行同一构建器；不得把用户主动触发的同步改成依赖 Claude 会话、Claude 浏览器控制或人工复制粘贴，也不得创建每日或开机整理任务。

私人状态在 `.xhs-favorites/`，面板白名单在 `config/xhs-favorites.json`。旧版的 `knowledge-base/` 已停止生成，若仍在磁盘上可手动删除。不得把 Cookie 或浏览器会话信息写入任何文件或回复。`xsec_token`（访问码）只能作为该卡片自己 `sourceUrl` 的整个值公开；除此之外不得写入任何文件、日志或回复，同步服务把它存在 `.xhs-favorites/source-codes.json`，不读取、不打印。

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for rowland-dot/favsense, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
