# 发布与公网知识库指南

FavSense 把采集和展示分成两层：本机负责登录小红书、下载、分析和保存完整知识库；公网只托管系统生成的脱敏网页。这样既能在任何设备上使用知识库，又不会把 Cookie、原始视频或私人配置上传到公共仓库。

## 1. 发布前检查

```powershell
npm.cmd run release:check
git status --short --ignored
```

以下目录必须保持为 ignored，而不是 staged：

- `.xhs-favorites/`：私有 catalog、运行记录、视频与证据画面；
- `.xhs-tools/`：本机下载器和运行环境；
- `knowledge-base/`：可在 Obsidian 打开的完整本地知识库；
- `config/xhs-favorites.json`：包含个人主页、收藏夹和发布目标的私有配置；
- `site/.local/`：本机回环服务地址。

`site/data/knowledge.json` 是允许发布的网页数据。提交或发布前，请确认你愿意公开其中的帖子标题、作者名、原帖链接和 FavSense 生成的总结。原始视频、抽帧图片、浏览器登录态和访问令牌不会进入该文件。

## 2. 发布开源代码到 GitHub

在 GitHub 创建空仓库后运行：

```powershell
git add .
git diff --cached
git commit -m "Initial open-source release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/favsense.git
git push -u origin main
```

修改 `site/site-config.js`，把页面右上角的作者入口指向自己的空间：

```js
window.FAVSENSE_CONFIG = {
  repositoryUrl: "https://github.com/YOUR_USERNAME/YOUR_REPOSITORY",
  creatorGitHubUrl: "https://github.com/YOUR_USERNAME",
  creatorName: "YOUR_NAME"
};
```

GitHub 仓库用于发布程序、文档、示例配置和可公开的演示数据。它不是私人收藏的备份位置。

### 可选：GitHub Pages 演示

在 GitHub Actions 中手动运行 **Deploy demo to GitHub Pages**，即可把 `site/` 发布为演示站点，不需要 Node 服务器。个人每日收藏仍建议直接发布到自己的 Hugging Face Space，避免把私有工作流和开源代码更新混在一起。

### 让 Agent 配置资源索引

部署前，Agent 必须先根据用户收藏主题选择或创建 `domain_profile`，不能默认沿用演示站的 software 标签。内容形态由该文件的 `content_kinds`、`classification` 与可选 `fallback.kind_rules` 共同决定：健身库不显示 Skill/Tool，护肤库不显示 Movement/Program。网页会从构建数据动态生成筛选项；若规则引用未声明的类型，构建器会直接失败。切换或新增领域后，先运行 `build-public-site.mjs` 并检查 `site/data/knowledge.json` 的 `meta.profileId` 与 `meta.kindLabels`，再发布。

部署者可以让任意 Agent 读取当前领域的 `domain_profile.resource_index` 和对应 `registry_file`，再根据实际数据生成资源索引。Agent 必须遵守以下接口：

1. `groups` 是一级资源类型；`sorts` 是依附于当前类型的二级选项；
2. 名称等通用排序不写 `applies_to`；Star、价格、浓度等专属排序必须绑定到确实拥有该字段的资源类型；
3. Star 排序只能提供给开源项目，不能出现在网站、文档、教程或非 GitHub 资源中；
4. 每个领域至少提供一个通用排序，切换类型后页面会自动选择有效值；
5. 只能使用注册表已有字段和可核验 URL，不得为了填满卡片虚构指标或入口。

完整 JSON 接口、示例和 Agent 决策顺序见 [资源索引领域接口](RESOURCE_INDEX.md)。Agent 修改后必须运行：

```powershell
node .\skills\xhs-favorites-organizer\scripts\build-public-site.mjs
npm.cmd run release:check
```

## 3. 创建 Hugging Face 公网知识库

FavSense 使用 Hugging Face 的 **Static HTML** SDK。网页中的搜索、筛选、主题切换、详情抽屉、书签、个人修订和资源索引都在浏览器中运行，不需要 Python 服务、Docker、GPU 或付费算力。

1. 打开 [Create a new Space](https://huggingface.co/new-space)。
2. SDK 选择 **Static HTML**。
3. 根据需要选择 Public、Protected 或 Private。
4. 创建后记下仓库地址：`https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME`。
5. 首次发布可以直接推送整个开源仓库：

```powershell
git remote add space https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME
git push space main
```

如果 Space 已经有初始提交，不要 force push。先克隆 Space，再把 FavSense 合并或复制进去，以保留初始历史。根目录 `README.md` 已包含必要配置：

```yaml
sdk: static
app_file: site/index.html
fullWidth: true
header: mini
hf_oauth: true
hf_oauth_scopes:
  - contribute-repos
```

`contribute-repos` 是这里需要的最小额外权限：它只允许 FavSense 创建并访问由当前 OAuth 应用创建的仓库，不能读取或修改用户已有的其他仓库。用户首次在“同步设置 → 个人数据”登录后，FavSense 会在该用户账号下创建一个私有 Dataset，并把 `personal.json` 写入其中。该文件只包含书签状态、冲突处理时间戳和用户主动修订的描述，不包含 Cookie、小红书登录态、收藏夹 ID、原始视频或帧证据。每次读写前都会重新确认 Dataset 仍为私有；如果用户将它改为公开，FavSense 会停止云同步并保留浏览器本地版本。

本地预览、GitHub Pages 或未登录状态会继续使用浏览器 `localStorage`。这份本地副本用于离线降级；用户也可以随时导出或导入 JSON。换设备时登录同一 HF 账号后，页面会读取私有 Dataset 并与本地副本合并。OAuth access token 由官方客户端产生并有过期时间，不应手动复制到配置或 Git 仓库。

FavSense 默认保留 Hugging Face README 中的 `header: mini` 浮动工具栏。网页只有在确认自己嵌入于 `huggingface.co/spaces/...` 且 `site/site-config.js` 标记为 mini 模式时，才把右上角的作者入口和主题按钮浮动放在 mini header 下方。它们使用首屏已有的顶部留白，不增加 FavSense 头部高度，也不下移正文；本地预览、直接访问 Static Space、GitHub Pages 和 `default` 模式均按普通布局显示。

用户主动整理后的发布器更新脱敏的 `site/` 时，会把 Space 根目录 README 前置配置中的 `header` 规范为 `mini`，并确保启用 HF OAuth 与 `contribute-repos` 权限，同时保留其余元数据和说明正文。公开的 `site/site-config.js` 使用同一模式，只调整右上角操作区的浮动位置，不改变头部尺寸或非 Hugging Face 部署的布局。

Static Space 的直接访问地址通常是：

```text
https://YOUR_HF_USERNAME-YOUR_SPACE_NAME.static.hf.space/index.html
```

也可以始终从 `https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME` 打开嵌入页面。

## 4. 配置主动整理后的发布

先复制私人配置模板：

```powershell
Copy-Item .\config\xhs-favorites.example.json .\config\xhs-favorites.json
```

在 `config/xhs-favorites.json` 中启用发布：

```json
{
  "publish": {
    "enabled": true,
    "provider": "huggingface",
    "repository": "https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME",
    "branch": "main"
  }
}
```

配置文件里不要写 Token。创建一个只对目标 Space 有写权限的 Hugging Face fine-grained token，并让 Git 使用系统凭据管理器保存它。Windows 用户可在第一次 `git push` 时输入 Hugging Face 用户名和该 Token；也可以安装 Hugging Face CLI 后运行：

```powershell
hf auth login --add-to-git-credential
```

用下面的命令测试一次发布：

```powershell
node .\skills\xhs-favorites-organizer\scripts\publish-huggingface.mjs `
  --workspace . `
  --repository https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME `
  --branch main
```

完成本机设置：

```powershell
.\favsense.ps1 setup
```

之后每次需要更新时：

1. 运行 `.\favsense.ps1 preview` 打开本地工作台；
2. 在“同步设置”选择收藏夹并点击“开始整理”；
3. FavSense 才会打开普通 Chrome，Tampermonkey 依次同步已启用的收藏夹；
4. 本机更新 `.xhs-favorites/` 和 `knowledge-base/`；
5. 构建器重建 `site/data/knowledge.json`；
6. 最后一个收藏夹完成后，发布器把 `site/` 镜像到 Space、排除 `site/.local/`，并确保 Space 使用 `header: mini`；
7. Hugging Face 刷新公网知识库。关闭本地工作台后，回环服务随之停止。

发布失败不会撤销本地整理结果。失败信息写入本次运行状态，下次同步可再次发布。没有内容变化时，发布器返回 `unchanged`，不会产生空提交。

## 5. 数据到底保存在哪里

| 数据 | 本机 | Hugging Face | GitHub |
|---|---:|---:|---:|
| 私有 catalog、运行记录 | 是 | 否 | 否 |
| 原始视频、抽帧和核验证据 | 是 | 否 | 否 |
| Obsidian Markdown 知识库 | 是 | 否 | 否 |
| 脱敏网页与 `knowledge.json` | 是 | 是 | 可选的公开演示 |
| 书签与个人描述修订 | 浏览器副本 | 用户私有 Dataset | 否 |
| Cookie、Token、个人配置 | 是 | 否 | 否 |

因此，“两边都有”指的是：完整数据和 Obsidian 知识库在本机；脱敏网页知识库发布到 Space；书签与个人描述修订在浏览器保留副本，并在用户登录后同步到私有 HF Dataset。Hugging Face 仍然不是原始视频或账号数据的备份位置。

## 6. 为什么默认不使用 Docker

Static Space 已能完整承载当前网页，而且没有容器休眠、临时磁盘和服务维护成本。需要跨设备保存的少量个人状态通过 HF OAuth 写入私有 Dataset，不需要为了一个 JSON 文件持续运行付费容器。小红书采集依赖普通 Chrome 中的扫码登录态，本机运行最稳定，也更符合最小暴露原则。

只有在需要以下能力时才考虑 Docker Space：

- Hugging Face 内运行服务端 API；
- 多用户账号和权限系统；
- 服务端数据库或搜索引擎；
- 在云端执行采集或分析任务。

即使改用 Docker，Space 本地磁盘仍不应被当作长期数据库；需要另配 Hugging Face Dataset、Storage Bucket 或外部数据库。当前的书签与个人修订已经直接使用私有 Dataset，因此只有真正需要服务端计算或复杂权限系统时才值得升级 Docker。

## 7. GitHub Actions 与个人知识库的区别

Hugging Face 官方 `huggingface/hub-sync` Action 可以在 GitHub `main` 更新时同步 Space，适合发布开源程序和公共演示。但个人收藏数据只在本机生成，不会进入 GitHub，因此默认由用户主动整理完成后的本机发布器直接更新 Space。

如果团队明确决定把 `site/data/knowledge.json` 也提交到 GitHub，可以改用官方 Action；请把 `HF_TOKEN` 存在 GitHub Actions Secret 或使用 Trusted Publisher，绝不能写进仓库。

## 8. 故障排查

- Space 页面显示 Running 但普通 `.hf.space` 返回 404：Static SDK 的直接域名包含 `.static.hf.space`。
- 手动发布提示认证失败：重新登录 Hugging Face Git 凭据，并确认 Token 对目标 Space 有写权限。
- 本地有新卡片但公网没变化：查看 `.xhs-favorites/runs/` 最新状态中的 `publish` 字段。
- “开始整理”没有出现：请确认当前地址是 `http://127.0.0.1:8766`，并通过 `.\favsense.ps1 preview` 启动本地工作台。
- 点击后没有打开 Chrome：确认普通 Chrome 已安装且小红书登录有效，然后查看设置页显示的本机错误信息。
- 网页更新了但数据不对：先执行 `npm.cmd run release:check`，再检查 `site/data/knowledge.json`。

官方参考：[Static HTML Spaces](https://huggingface.co/docs/hub/spaces-sdks-static)、[Space OAuth](https://huggingface.co/docs/hub/spaces-oauth)、[Hugging Face JavaScript Hub API](https://huggingface.co/docs/huggingface.js/en/hub/README)、[Spaces 配置](https://huggingface.co/docs/hub/spaces-config-reference)、[GitHub Actions 同步](https://huggingface.co/docs/hub/repositories-github-actions)。
