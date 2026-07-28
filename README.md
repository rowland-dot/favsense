---
title: FavSense · 拾光台 · 小红书收藏知识工作台
emoji: 🎞️
colorFrom: red
colorTo: pink
sdk: static
app_file: site/index.html
fullWidth: true
header: mini
license: mit
short_description: 自动同步小红书收藏，通过视频分析、资源索引与 Obsidian 输出生成可搜索、可追溯、可行动的知识库
tags:
  - knowledge-base
  - xiaohongshu
  - rednote
  - favorites-manager
  - bookmark-organizer
  - knowledge-management
  - local-first
  - static-site
  - agent-skill
  - obsidian
  - tampermonkey
  - video-analysis
  - automation
---

# FavSense · 拾光台

> Make sense of what you save.

FavSense 是一套本地优先、可独立运行的小红书 / RedNote 收藏整理引擎：自动同步收藏，通过视频画面分析识别短暂出现的信息，再生成可搜索、可追溯、可行动的知识库、资源索引与 Obsidian 笔记。

**Automated Xiaohongshu / RedNote favorites organizer with video analysis, a domain-aware resource index, Obsidian output, and a deployable static knowledge-base UI.**

它不是一组需要每天打开的 Markdown 文件，而是一条本机自动同步、确定性整理、静态网页阅读的完整链路。公开网页可以零后端部署到 GitHub Pages 或 Hugging Face Static Spaces。

项目由两层组成：

- **本地私有层**：普通 Chrome、Tampermonkey、本地服务和计划任务负责只读同步；Cookie、临时 Token、原始视频和个人收藏配置不进入 Git。
- **公开展示层**：零后端静态网页展示原创总结、领域资源、权威来源和下一步行动，可免费部署到 Hugging Face Static Space。

## 网页功能

- 视觉化知识卡，不需要每天打开一堆 Markdown；
- 全文搜索，以及主题、Skill/Tool/Workflow/Product 内容形态筛选；
- “同步设置”页首屏列出全部收藏夹，可用独立开关决定每日同步或忽略；
- 单篇详情抽屉，集中显示深度总结、行动建议和相关资源；
- 可配置资源索引：software 归类开源项目、网站、文档与教程，fitness 显示训练资料，skincare 显示成分与使用边界；
- 深色模式、响应式移动端与键盘操作；
- 公开网页不包含登录态、个人主页、收藏夹 ID、视频文件或帧图片。

## 快速预览

仓库已经包含经过脱敏的演示数据。Node.js 20+ 环境直接运行：

```powershell
npm run preview
```

然后打开 `http://127.0.0.1:8766`。不要直接双击 `index.html`，浏览器会阻止读取 JSON 数据。

发布前统一执行：

```powershell
npm run release:check
```

## 配置自己的收藏同步

要求：Windows、普通 Chrome、Tampermonkey、Node.js 20+、Python 3.11+。

```powershell
Copy-Item ".\config\xhs-favorites.example.json" ".\config\xhs-favorites.json"
```

编辑私有配置中的个人主页和收藏夹 ID，然后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  ".\skills\xhs-favorites-organizer\scripts\setup-autosync.ps1" `
  -Workspace "." -Config ".\config\xhs-favorites.json"
```

安装命令会启动本机服务并创建 Windows 每日任务。命令完成后，在装有 Tampermonkey 的普通 Chrome 中打开：

```text
http://127.0.0.1:47631/xhs-favorites.user.js
```

在 Tampermonkey 安装页确认安装后，自动同步才正式启用。计划时间来自 `config/xhs-favorites.json` 的 `schedule_local`。

Windows 用户也可以使用统一入口：

```powershell
.\favsense.ps1 setup
.\favsense.ps1 sync
.\favsense.ps1 preview
.\favsense.ps1 verify
```

生成 Obsidian 知识库和公开网页数据：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  ".\skills\xhs-favorites-organizer\scripts\run-daily.ps1" -Mode daily

node ".\skills\xhs-favorites-organizer\scripts\build-public-site.mjs"
```

每日同步本身不依赖 Codex、Claude 或其他 Agent。Agent 只作为可选的二次策展者，并统一读写项目内的开放 JSON/Markdown 数据。

网页中的收录数、深度解读数、可复核画面数和资源数不是手工展示值：构建器从当前 catalog、`.xhs-favorites/video-analysis/` 的本机证据文件以及领域资源注册表重新计算。每次每日同步完成后都会重建网页数据；画面路径和原始文件不会进入公开 JSON。

`setup-autosync.ps1` 会为本机网页生成 Git 忽略的 `site/.local/bridge.json`，其中只有回环服务地址，不包含 token。收藏夹开关只在本机工作台显示并直接更新私有配置；部署到 GitHub 或 Hugging Face 后只显示不含账号信息的本机连接说明。关闭收藏夹只停止后续采集，不会删除已经整理的知识卡。

## 小红书来源与领域配置

当前采集适配器只连接小红书：普通 Chrome 中的用户脚本读取你有权访问的收藏面板，本地桥接服务增量去重并重建知识库。采集层不包含软件、GitHub 或健身规则。

`config/xhs-favorites.json` 通过两个路径决定整理方式：

- `domain_profile`：领域分类、内容形态、首页叙事和资源索引接口；
- `curation_file`：逐篇人工策展与自动判断覆盖。

仓库提供 software、fitness 与 skincare 三个领域模板。当前公开演示使用 software；切换领域不会改变小红书登录、同步、去重和隐私边界。

## 发布到 GitHub

先确认私有文件均显示为 ignored：

```powershell
git status --short --ignored
node --test ".\skills\xhs-favorites-organizer\tests\test_public_site.mjs"
```

然后创建 GitHub 仓库并推送：

```powershell
git add .
git commit -m "Initial open-source release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/favsense.git
git push -u origin main
```

发布目标已配置为 `https://github.com/rowland-dot/favsense`，网页右上角会显示“开源项目”入口。在 Hugging Face 也可以创建公开 Space Variable `GITHUB_REPOSITORY_URL` 覆盖它，无需改代码。

同一配置中的 `creatorGitHubUrl` 和 `creatorName` 控制右上角作者空间入口；开源使用者替换这两个字段即可指向自己的 GitHub。没有配置有效 GitHub 地址时，入口自动隐藏，不会产生失效链接。

提交前务必检查 staged diff；不要使用 `git add -f` 强行加入 `.xhs-favorites/`、`knowledge-base/` 或私有配置。

## 发布到 Hugging Face Spaces

1. 在 Hugging Face 选择 **Create new Space**。
2. SDK 选择 **Static HTML**，可见性由你决定。
3. 创建后，把同一仓库推送到 Space：

```powershell
git remote add space https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME
git push space main
```

根目录 README 已配置 `sdk: static` 和 `app_file: site/index.html`，因此 Space 不需要 Python 服务、容器或付费硬件。

更完整的发布与更新流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 仓库结构

```text
site/                                 公开静态网页与脱敏数据
skills/xhs-favorites-organizer/       跨 Agent、可独立运行的同步 Skill
config/xhs-favorites.example.json     可公开的配置模板
config/xhs-favorites.json             本机私有配置（Git 忽略）
.xhs-favorites/                       私有 catalog、原始视频和分析画面（Git 忽略）
knowledge-base/                       本机 Obsidian 输出（Git 忽略）
scripts/                              零依赖预览与发布检查
.github/                              CI、Issue、PR 与 Pages 模板
AGENTS.md / CLAUDE.md                 跨 Agent 的安全协作规则
```

## 通用资源索引

同一页面组件由 `domain_profile.resource_index` 驱动。software 同时归类开源项目、官方网站、官方文档、教程与参考资料；fitness 把实体定义为训练资料；skincare 把实体定义为成分与方案。三个模板共用搜索、类型筛选、配置化排序和来源入口，页面中没有 GitHub 或 Star 的固定字段。排序是资源类型的二级能力：例如 Star 排序只在“开源项目”中出现。完整接口与 Agent 自动搭建规则见 [资源索引领域接口](docs/RESOURCE_INDEX.md)。

## 文档

- [发布到 GitHub、Pages 与 Hugging Face](docs/PUBLISHING.md)
- [系统架构与信任边界](docs/ARCHITECTURE.md)
- [资源索引领域接口](docs/RESOURCE_INDEX.md)
- [路线图](ROADMAP.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)

## 安全与合规边界

- 只处理本人有权访问的收藏和公开内容；不点赞、不评论、不发布、不取消收藏。
- 不绕过验证码、安全限制或平台风控。
- 不读取、导出或持久化 Chrome Cookie。
- 小红书内容版权属于原作者；公开演示只包含链接、必要元数据和本项目原创总结，不发布下载的视频或抽帧图片。
- GitHub Star 是核验日期当时的快照，不代表安全性或推荐结论。

## 贡献与许可证

项目采用 [MIT License](LICENSE)。提交改进前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
