# 知识卡片规则

## 来源层与知识层分离

小红书收藏夹只记录在 `source_boards`，不直接决定知识主题。每篇笔记只选一个主分类，可有 1 至 3 个主题标签，并通过共享主题建立关联卡片。

## 策展字段

- `category`：一个稳定主分类。
- `themes`：1 至 3 个可检索概念。
- `summary`：说明内容提供了什么，不复述标题，建议不超过 80 字。
- `action`：系统自动提取的应用建议；不是要求用户维护的待办。
- `kind`：可选的内容形态人工覆盖值，必须属于当前 `domain_profile` 的 `content_kinds`。例如 software 使用 `Tool`、`Skill`、`Workflow`、`Product`，fitness 使用 `Movement`、`Program`、`Claim`、`Product`。省略时由公开网页构建器自动判断。
- `tools`：只写可确认的工具或项目名称；不确定则留空。

系统处理全部合法收藏，不要求用户为每篇笔记维护等级、处理状态、用户决策或证据状态。可靠性信息以具体来源和核验说明呈现，不压缩成单个字母或状态标签。

内容形态默认根据已核验项目类型和摘要语义自动判断。自动判断错误时，在对应策展记录中写入 `"kind": "Workflow"` 等值即可稳定覆盖；重新运行构建器后，网页与知识库使用人工值。静态公开网页只负责浏览和筛选，不直接回写项目源文件。

## 视频证据规则

视频笔记的标题、封面、简介和标签只能用于建立待处理记录，不能直接生成最终工具名或结论。最终策展前必须：

- 完整解码源视频；
- 至少保留每 0.5 秒序列帧和转场帧；
- 复核帧中的项目名、仓库 owner/repo、命令、功能和限制；
- 对快速闪现或小字号片段提高局部抽帧密度；
- 在 `.xhs-favorites/video-analysis/<note-id>/` 保存可复核证据；
- 将视频中的候选实体与官方 GitHub/官网分开核验。

若无法可靠读出项目名，`tools` 保持为空，摘要写“视频帧未能唯一确认项目”，不得从营销标题猜测。

## Skill 专项核验

任何内容只要明确提到 Skill，都必须额外核实并记录：

- `skill_name`：官方项目名；
- `skill_type`：`agent-skill`、`plugin`、`prompt-pack`、`workflow` 或 `unknown`；
- `github_repo`：官方 GitHub 仓库；
- `github_download`：GitHub 分支或 Release 的直接下载地址；
- `github_stars`：核验时 GitHub 显示的 Star 数；
- `stars_verified_at`：核验日期；
- `compatibility`：明确支持的 Agent 宿主；

这些信息同时写入对应知识卡片和 `knowledge-base/05-Skills成果/GitHub-Skills核验清单.md`。官方仓库不能唯一确认时，`skill_type` 写 `unknown`，其余不可确认字段留空并说明缺失原因。不得照抄帖子里的 Star 数，也不得仅凭 Star 数推荐安装。

## 主题分类

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
