# 知识卡片规则

## 收藏夹优先的分类协议

默认使用 `source-board-first`：小红书收藏夹决定知识卡的主分类，内容识别补充 1 至 3 个主题标签，并在判断不一致时生成 `suggested_category`。建议分类只在详情中提示，不会自动拆乱侧栏。只有策展记录明确写入 `"category_override": true` 时，内容分类才覆盖收藏夹；同时必须填写 `category_reason` 说明原因，否则构建失败。

收藏夹配置可选 `category`，用于把原收藏夹名称映射成更适合公开展示的名称；省略时直接使用收藏夹原名。同一笔记来自多个收藏夹时，`category_priority` 数值较高者成为主分类。需要沿用内容优先行为的领域可以显式设置 `classification.category_strategy` 为 `content-first`。

## 策展字段

- `category`：内容判断或人工建议的分类；在默认协议下不会自动覆盖收藏夹。
- `category_override`：可选布尔值。仅在明确需要跨收藏夹归档时设为 `true`。
- `category_reason`：人工覆盖的简短依据；不保存账号或私有采集信息。
- `themes`：1 至 3 个可检索概念。
- `summary`：说明内容提供了什么，不复述标题，建议不超过 80 字。
- `action`：系统自动提取、且必须针对当前收藏的应用建议；不是要求用户维护的待办。未完成解读时保持为空，网页和 Obsidian 均不显示占位内容。
- `kind`：可选的内容形态人工覆盖值，必须属于当前 `domain_profile` 的 `content_kinds`。例如 software 使用 `Tool`、`Skill`、`Workflow`、`Product`，fitness 使用 `Movement`、`Program`、`Claim`、`Product`。省略时由公开网页构建器自动判断。
- `tools`：只写可确认的工具或项目名称；不确定则留空。

系统处理全部合法收藏，不要求用户为每篇笔记维护等级、处理状态、用户决策或证据状态。可靠性信息以具体来源和核验说明呈现，不压缩成单个字母或状态标签。

内容形态默认根据已核验项目类型和摘要语义自动判断。对于尚未进入策展 JSON 的收藏，构建器先使用领域配置的 `fallback.kind_rules` 做保守候选判断，而不是统一标成 `Note`。`Note` 只表示观点、资讯或一般知识说明，不代表“尚未处理”。规则判断为 Skill 但未满足 accepted/current/resource 门时，正式 `kind` 使用领域中性 fallback，并额外输出 `candidateKind="Skill"`；只有 accepted 且恰好关联一个 fresh verified resource 时才是 `confirmed Skill`。自动判断错误时，在对应策展记录中写入 `"kind": "Workflow"` 等值即可稳定覆盖；重新运行构建器后，网页与知识库使用当前合法值。静态公开网页只负责浏览和筛选，不直接回写项目源文件。

不同领域拥有不同的 `content_kinds`，网页筛选器必须从当前构建结果动态读取，不能假设所有知识库都有 Tool、Skill 或 Workflow。领域模板应同时声明标签说明、默认类型和匹配规则；构建时若规则引用了本领域未声明的类型，必须直接失败。

缺少原帖标题时，构建器从公开描述或摘要提炼稳定标题；若正文也缺失，则使用作者或笔记 ID 尾段形成可区分名称，不能显示“未命名收藏”。领域 fallback 的默认类别必须使用“其他…”或“待归类”等中性名称，具体类别只能由明确关键词或策展覆盖产生。

小红书的裸 `/explore/{id}` 直达链接可能因缺少临时签名而失效，公开数据又不得保存 `xsec_token`。因此公开网页与 Obsidian 卡片使用“标题 + 作者”的小红书站内检索入口，并将按钮明确标为“搜索原帖”。本地工作台连接回环桥接时可以只提交稳定 `note_id`，由桥接打开来源收藏夹并让用户脚本使用页面内当前实时签名精确跳转；签名只在该浏览器动作的内存中存在，不写入 catalog、卡片或公开 JSON。

## 视频证据规则

视频笔记的标题、封面、简介和标签只能用于建立待处理记录，不能直接生成最终工具名或结论。使用分级证据，按需增加计算量：

1. **音频层（默认）**：离线转写整条音频，保留时间戳和识别置信信息；先从语音确定主题、用途、步骤及候选实体。
2. **稀疏视觉层（有条件）**：仅当语音没有唯一名称、语音指向屏幕、音频过少或识别质量不足时，提取每 5 秒一帧、转场帧和 overview。
3. **局部密集层（最后手段）**：稀疏画面仍未确认时，只对可疑时间段按每 0.5 秒抽帧，不对整条视频默认密集抽帧。

进入视觉层前必须列出 `missing_facts`。按时间顺序核验时，只要这些缺失事实全部找到，立即停止查看剩余画面，不因“已经生成了帧”而继续消耗上下文。随后只核验官方来源；不得再次解析原视频，除非官方来源与已识别实体发生冲突。

超长视频先处理前 10 分钟并记录音频窗口。若已找到实体和关键内容则停止；否则继续下一音频窗口。任何截断结果必须保留 `audio_window.truncated: true`，不能声称完整覆盖整条视频。

在 `.xhs-favorites/video-analysis/<note-id>/` 保存 `transcription.json`、视觉升级原因和必要帧。语音或画面中的候选实体仍需与官方 GitHub/官网分开核验。若无法可靠读出项目名，`tools` 保持为空并明确写“未能唯一确认项目”，不得从营销标题猜测。标题或转写提到 GitHub、开源或仓库时，仅识别品牌名仍不算完成核验；必须获得可唯一定位的 `owner/repo`。公开仓库也不能直接推断为开源源码或 Agent Skill，仍须分别检查源码、许可证与 Skill 结构。

## Skill 专项核验

任何内容只要明确提到 Skill，都必须额外核实并记录：

- `skill_name`：官方项目名；
- `skill_type`：`agent-skill`、`plugin`、`prompt-pack`、`workflow` 或 `unknown`；
- `github_repo`：官方 GitHub 仓库；
- `github_download`：GitHub 分支或 Release 的直接下载地址；
- `github_stars`：核验时 GitHub 显示的 Star 数；
- `stars_verified_at`：核验日期；
- `compatibility`：明确支持的 Agent 宿主；
- `resource_identity_sha256`：绑定 canonical repo、官方名称/类型、license、manifest、compatibility 与官方证据位置；
- `verification_snapshot_sha256`：绑定 identity、默认分支、下载地址、Star 与核验日期；

这些信息同时写入对应知识卡片和 `knowledge-base/05-Skills成果/GitHub-Skills核验清单.md`。官方仓库不能唯一确认时，`skill_type` 写 `unknown`，其余不可确认字段留空并说明缺失原因。不得照抄帖子里的 Star 数，也不得仅凭 Star 数推荐安装。

confirmed Skill 的资源动作必须至少包含名称可区分的“官方仓库”和“下载 ZIP”；详情页遍历全部安全动作，不只取第一项。0 个或多个 verified resource、过期 snapshot、identity 变化或字段缺失都会使条目回到候选/待审核状态，且不得生成猜测链接。

## software 示例主题

以下仅是 software 演示领域的内容建议标签，不是 FavSense 的全局分类，也不会出现在健身、护肤等其他知识库中：

- 信息采集与搜索
- Skills与工作流
- Agent与自动化
- 知识管理与记忆
- 开发部署与Vibe Coding
- 内容增长与商业
- AI设计与多媒体
- 本地模型与成本
- 垂直工具与数据

## 不充分信息

正文不足时保留来源，摘要明确写“待补充”，应用建议改为补全项目原址、许可证或验证材料。不得根据夸张标题臆测产品能力。
