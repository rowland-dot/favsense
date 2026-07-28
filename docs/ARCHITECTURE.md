# 架构说明

FavSense · 拾光台把“使用者的私有采集环境”和“可以公开部署的阅读界面”严格分开。日常同步不依赖 Codex、Claude 或任何特定 Agent。

```mermaid
flowchart LR
  XHS["普通 Chrome 中的小红书收藏夹"] --> TM["Tampermonkey 只读脚本"]
  TM -->|"回环地址 + token"| BRIDGE["本机 Bridge"]
  BRIDGE --> CATALOG["私有 Catalog"]
  CATALOG --> KB["Obsidian 知识库"]
  CATALOG --> BUILD["确定性公开数据构建器"]
  BUILD --> SITE["纯静态 FavSense · 拾光台网页"]
  SITE --> GH["GitHub Pages"]
  SITE --> HF["Hugging Face Static Space"]
```

## 两条信任边界

### 本地私有层

包含个人收藏夹配置、随机 bridge token、去重 catalog、原始媒体、视频分析画面和本地工具。它们都在 `.gitignore` 中，服务只监听 `127.0.0.1`。

“同步设置”页的 `.local/bridge.json` 只保存回环服务地址。只有固定工作台 Origin `http://127.0.0.1:8766` 能从回环服务取得本机凭据并修改收藏夹范围；公共托管没有该文件，因此只显示不含账号信息的本机连接说明。

### 公开展示层

`site/` 只包含原创摘要、公开原帖链接、必要元数据和经过核验的资源信息。它不需要后端、数据库、GPU 或构建框架，可以直接由任意静态托管服务发布。

## 数据流

1. 用户脚本只在配置白名单中的收藏夹页面运行并收集笔记链接。
2. Bridge 校验 Host、token、面板 ID、请求大小和小红书 URL。
3. 新笔记按 ID 增量去重；失败条目单独记录，不循环重试。
4. 构建器从私有 catalog 生成 Markdown 与脱敏 `site/data/knowledge.json`。
5. 网页在浏览器中完成搜索、筛选、排序和详情展示。

## 领域层与资源索引

采集来源和知识领域分离：小红书适配器只负责获取收藏，`domain_profile` 负责内容分类、页面叙事与资源索引。构建器把不同领域注册表编译为统一的 `resources` 结构，前端再读取领域配置提供的实体字段、分组筛选、排序、指标和权威入口。software、fitness 与 skincare 已共用这条链路，接口见 [资源索引领域接口](RESOURCE_INDEX.md)。

## 关键设计决策

- 纯静态公开站点：部署轻、成本低，也缩小了公开攻击面。
- 确定性构建器：相同输入产生相同结构，不把每日运行绑定到某个模型供应商。
- 原始证据留在本机：公开知识可以分享，账号登录态和版权材料不随之发布。
- 收藏夹是来源，不是分类：同一收藏夹里的内容仍按真实主题和内容形态整理。
