# Claude 项目说明

处理小红书收藏同步、整理、知识卡片、面板或 Obsidian 知识库任务前，完整阅读并遵循：

`skills/xhs-favorites-organizer/SKILL.md`

核心运行链路必须保持 Agent 无关。Claude 只能作为可选策展层编辑结构化 curation JSON，然后运行同一构建器；不得把用户主动触发的同步改成依赖 Claude 会话、Claude 浏览器控制或人工复制粘贴，也不得创建每日或开机整理任务。

私人状态在 `.xhs-favorites/`，知识库在 `knowledge-base/`，面板白名单在 `config/xhs-favorites.json`。不得把 `xsec_token`、Cookie 或浏览器会话信息写入任何文件或回复。
