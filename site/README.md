# Static site

`site/` 是可以直接部署到 Hugging Face Static Spaces、GitHub Pages 或任意静态托管平台的公开展示层。

- `index.html`：语义结构与无障碍入口；
- `styles.css`：无依赖响应式视觉系统；
- `app.js`：搜索、筛选、配置化资源索引、详情抽屉和本机同步范围管理；
- `personal-store.mjs`：书签、知识卡修订、导入导出与旧版数据迁移；
- `hf-personal-sync.mjs`：通过 HF OAuth 把个人数据写入用户自己的私有 Dataset；
- `hf-sync-guard.mjs`：在每次云端读写前确认 Dataset 仍为私有，公开时立即停止同步；
- `site-config.js`：可选的 GitHub 仓库地址；
- `data/knowledge.json`：经过脱敏的公开知识数据。
- `themes/README.md`：当前配色规范与未加载的历史主题归档。

重新生成数据：

```powershell
node ".\skills\xhs-favorites-organizer\scripts\build-public-site.mjs"
```

生成器只发布 note ID、公开原帖链接、必要公开元数据、原创摘要和资源核验信息。个人主页、收藏夹 ID、作者 ID、Cookie、临时 Token、视频和帧文件不会进入输出。

本机执行 `setup-autosync.ps1` 后会生成被 Git 忽略的 `.local/bridge.json`，其中仅保存回环服务地址，不保存 token。它使“同步设置”页能够显示收藏夹开关；公共静态部署没有该文件，只会显示不含账号信息的本机连接说明。

书签和描述修订默认写入当前浏览器的 `localStorage`。Hugging Face Static Space 开启 OAuth 后，网页只申请 `contribute-repos` 权限，并使用官方 `@huggingface/hub` 客户端把同一份个人数据写入由该应用创建的私有 Dataset。GitHub Pages 等没有 HF OAuth 环境的部署仍可使用本地保存和 JSON 导入导出。
