# 更新记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用语义化版本号。

## [Unreleased]

### Added

- 遗留安全停止：上一轮留下的安全停止记录会在“开始整理”打开扫描浏览器之前拒绝开始，工作台加载时显示“<日期> 的安全停止尚未清除”和触发阶段，并提供“已确认恢复，清除并继续”（记录归档保留，随即开始一轮整理）。
- “同步设置”页新增“仅本地重建”：不接触小红书，用当前完整 catalog 重建知识库与网页，并按配置最多发布一次。
- “同步设置”页：首屏列出本机全部小红书收藏夹，用开关选择整理范围，并通过本地“开始整理”按钮主动触发。
- 通用资源索引：由领域配置归类开源项目、网站、文档、教程和领域资料。
- software、fitness 与 skincare 三套模板；公开演示使用 software 资源索引。
- 右上角可配置的 GitHub 作者空间入口。
- 三个页面各自拥有独立的格子纸首屏。
- `npm run preview`、`npm test`、`npm run release:check` 和 `favsense.ps1` 统一入口。
- `FavSense · 拾光台` 品牌、`Make sense of what you save.` 标语与 `rowland-dot/favsense` 发布地址。
- GitHub Issue、Pull Request、CI 和手动 Pages 部署模板。
- 知识卡书签、只看书签、书签关联资源筛选与个人描述修订。
- 免费 Hugging Face Static Space 的 OAuth 私有同步：个人数据写入用户自己的私有 Dataset，同时保留本地导入导出。

### Changed

- 公开判定 module（`public-judgement.mjs`）成为一篇笔记“是否 accepted、内容形态、关联资源、摘要来源、分类”的唯一判定者：知识库与网页两个构建器只负责排版它的结论。知识库卡片随之改变：策展没写内容形态时按领域规则自动判断（不再写“自动判断”占位）；没有可发布策展的笔记采用网页现行的替补内容（240 字摘录、主题为空、同样的形态规则）；已审核笔记留空的字段保持留空。资源核验有效期读领域配置的 `resource_index.verification_max_age_days`，缺省 30 天。网页数据没有变化。
- 资源核验有效期只由领域配置的 `resource_index.verification_max_age_days` 决定（键不存在时 30 天），构建器、策展流水线、公开判定、审核合并和旧状态迁移共用同一个解析函数，不再有写死的 30。键写成 `null`、小数或字符串时直接报错并指出配置文件和键，不再把全部资源静默判为过期。审核合并现在必须拿到领域配置（命令行按 `--config` 里的 `domain_profile` 查找），迁移命令行从 `--root` 下的收藏配置查找，并把有效期计入 dry-run 确认：dry-run 之后改动有效期，apply 会拒绝。软件领域配置显式写出 30。仓库外直接调用 `mergeResults` 的私有批处理脚本需要自行传入 `profile`。
- 运行状态 module 成为整理运行记录和本地重建记录的唯一写入者：同步服务只报告事件，由它推进分阶段状态、计数并选定工作台显示的那句话（状态接口新增 `copy_key`，网页标题、详情与结束提示气泡只显示契约里该键的文案）；旧的单层记录只在读取时转换，下一次写入才改为分阶段格式。核心导入阶段触发的安全停止现在记在核心阶段，不再误报成总结阶段。
- 平台接触许可（`platform_access.py`）统一管理安全停止：页面上报和点点总结的停止现在也会留下记录；拦截识别规则在 Python 中只有一份；安全停止不再阻止离线转写与 OCR；整理结果在数量未知时写 `null`（工作台显示“未知”），不再写 0。
- 移除 Windows 每日与开机自动整理；旧版 `FavSense-Daily` 任务在升级设置时删除，本地桥接服务随工作台关闭。
- 知识卡顶部直接显示“主题 · 内容形态”，取消无意义的 Frame 编号。
- 视觉系统改为小红书式黑白灰主体、品牌红交互和高区分度便签色。
- 本机收藏夹管理不再把 bridge token 写入静态站点目录。
- 页面组件和公开数据从 GitHub `projects` 固定结构迁移为领域无关的 `resources` 结构。
- 个人数据格式升级到 v2，以时间戳和删除墓碑解决跨设备冲突，并串行提交云端更新。

### Security

- `/boards` 只接受带 token 的回环网页请求，配置和用户脚本更新失败时自动回滚。
- 私有配置、登录态、原始媒体、帧证据和本机运行时均由 Git 忽略。
- 每次 HF 个人数据读写前重新确认 Dataset 仍为私有；公开状态会立即停止同步。

## [0.1.0] - 2026-07-28

### Added

- 首个可公开演示版本：小红书收藏增量同步、知识卡、资源索引、Obsidian 输出和静态网页。

[Unreleased]: https://github.com/rowland-dot/favsense/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rowland-dot/favsense/releases/tag/v0.1.0
