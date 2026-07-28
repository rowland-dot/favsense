# 更新记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用语义化版本号。

## [Unreleased]

### Added

- “同步设置”页：首屏列出本机全部小红书收藏夹，并用开关设置每日同步或忽略。
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
