# 发布指南

## 1. 发布前检查

```powershell
npm run release:check
git status --short --ignored
```

以下目录必须显示为 ignored，而不是 staged：

- `.xhs-favorites/`
- `.xhs-tools/`
- `knowledge-base/`
- `xhs-favorites/`
- `config/xhs-favorites.json`

检查 `site/data/knowledge.json`，确认你愿意公开其中的帖子标题、作者名、原帖链接和原创总结。视频、抽帧图片和个人收藏配置不会被生成到这里。

## 2. GitHub

在 GitHub 创建空仓库，不要勾选自动生成 README 或 License，然后：

```powershell
git add .
git diff --cached
git commit -m "Initial open-source release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/favsense.git
git push -u origin main
```

仓库创建后设置 **About** 描述与 Topics。推荐值保存在 `.github/REPOSITORY_METADATA.md`；维护者可以使用 GitHub 网页设置，或通过 `gh repo edit` 一次性写入。描述同时使用“小红书”和“RedNote”，Topics 覆盖 favorites、knowledge base、Obsidian、local-first、video analysis 与 resource index，方便中英文用户检索。

编辑 `site/site-config.js`：

```js
window.FAVSENSE_CONFIG = {
  repositoryUrl: "https://github.com/YOUR_USERNAME/YOUR_REPOSITORY",
  creatorGitHubUrl: "https://github.com/YOUR_USERNAME",
  creatorName: "YOUR_NAME"
};
```

`creatorGitHubUrl` 和 `creatorName` 控制右上角作者空间入口。GitHub Actions 会运行静态站点、确定性构建和公开数据安全测试。

### 让 Agent 配置资源索引

部署者可以让任意 Agent 读取当前领域的 `domain_profile.resource_index` 和对应 `registry_file`，再根据实际数据自主生成资源索引配置。Agent 必须遵守以下接口约束：

1. `groups` 是一级资源类型；`sorts` 是依附于当前类型的二级选项；
2. 名称等通用排序不写 `applies_to`；Star、价格、浓度等专属排序必须用 `applies_to` 绑定到确实拥有该字段的 `groups[].label` 或 `default_group`；
3. Star 排序只能提供给开源项目，不能出现在网站、文档、教程或非 GitHub 资源中；
4. 每个领域至少提供一个通用排序，切换类型后页面会自动移除不适用的排序并选择有效默认值；
5. Agent 只能使用注册表已有字段和可核验 URL，不得为了填满卡片而虚构指标或入口。

完整 JSON 接口、示例和 Agent 决策顺序见 [资源索引领域接口](RESOURCE_INDEX.md)。Agent 修改后必须执行：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\build-public-site.mjs"
npm.cmd run release:check
```

这会重建公开数据，并检查类型、排序关联、资源动作和隐私边界。

如果启用了 GitHub Pages，在 Actions 中手动运行 **Deploy demo to GitHub Pages** 即可发布 `site/`，不需要 Node 服务器。

## 3. Hugging Face Static Space

根据 [Hugging Face Static HTML Spaces 官方文档](https://huggingface.co/docs/hub/spaces-sdks-static)：

1. 打开 [Create a new Space](https://huggingface.co/new-space)。
2. 输入 Space 名称。
3. SDK 选择 **Static HTML**。
4. 选择公开或私有可见性并创建。
5. 在终端添加 Space remote 并推送：

```powershell
git remote add space https://huggingface.co/spaces/YOUR_HF_USERNAME/YOUR_SPACE_NAME
git push space main
```

首次推送时使用 Hugging Face 用户名和具有写权限的 Access Token 完成 Git 凭据验证。不要把 Token 写入仓库、脚本或 `.env` 后提交。

也可以在 Space Settings 中添加公开变量 `GITHUB_REPOSITORY_URL`、`CREATOR_GITHUB_URL` 和 `CREATOR_NAME`，覆盖网页中的作者空间入口。

根目录 README 的 Space metadata 已包含：

```yaml
sdk: static
app_file: site/index.html
fullWidth: true
header: mini
```

无需 Docker、Python 运行时或 GPU。Space 会直接托管 `site/index.html` 及其相对资源。

## 4. 更新内容

本地同步完成后，网页 JSON 会由桥接服务自动重建。确认公开内容后：

```powershell
git add site/data/knowledge.json
git commit -m "Update curated knowledge"
git push origin main
git push space main
```

原始视频和分析画面始终只留在本机。
