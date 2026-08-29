# 架构说明

FavSense · 拾光台把“使用者的私有采集环境”和“可以公开部署的阅读界面”严格分开。用户主动触发的同步不依赖 Codex、Claude 或任何特定 Agent。

```mermaid
flowchart LR
  CLICK["本地设置页：开始整理"] --> PROFILE["刷新收藏夹清单与名称"]
  PROFILE --> XHS["SOP 扫描浏览器中的已启用收藏夹"]
  XHS --> TM["Tampermonkey 只读脚本"]
  TM -->|"回环地址 + token"| BRIDGE["本机 Bridge"]
  BRIDGE --> CATALOG["私有 Catalog + content revision"]
  CATALOG --> SUMMARY["captured summary / cached evidence"]
  SUMMARY --> CANDIDATE["candidate + resource assessment"]
  CANDIDATE --> AUDIT["audit：pending / accepted"]
  AUDIT --> BUILD["双输出 snapshot coordinator"]
  BUILD -->|"同一 build_version"| KB["正式 Obsidian 知识库"]
  BUILD -->|"同一 build_version"| SITE["纯静态 FavSense · 拾光台网页"]
  SITE --> GH["GitHub Pages"]
  SITE --> HF["Hugging Face Static Space"]
```

## 两条信任边界

### 本地私有层

包含个人收藏夹配置、随机 bridge token、去重 catalog、原始媒体、视频分析画面与本地工具。它们都在 `.gitignore` 中，服务只监听 `127.0.0.1`。浏览器登录态唯一保存在相邻 `SOP - 小红书` 项目的私有扫描 profile 中：SOP 拥有 Chrome 进程、profile 与动态端口登记，FavSense 只消费该 CDP 通道并管理自己创建的临时标签；它不读取 Cookie、不创建第二个 profile，也不回退到主浏览器。

“同步设置”页的 `.local/bridge.json` 只保存回环服务地址。Bridge 只接受固定工作台 Origin `http://127.0.0.1:8766` 的浏览器请求；公共托管没有该文件，因此既不显示触发按钮，也不具备本机控制能力。这里的 Origin 检查是浏览器边界，不是操作系统用户身份认证：回环端口对同机进程可见，当前本地控制面只支持由同一位受信任用户独占的工作站，不应在多用户共享主机或不受信任的本机进程环境中运行。启动页与 Bridge 返回的数据仍必须经过严格 schema 校验，不能把回环响应当成可信 HTML。

### 公开展示层

`site/` 只包含 accepted/current 的原创摘要、安全原帖入口、必要元数据和经过核验的资源信息。captured 但 pending 的证据只经鉴权 loopback 的“待审核” overlay 在本地显示；公共部署没有 descriptor、请求或私有 DOM 区域。静态站不需要后端、数据库、GPU 或构建框架，可以直接由任意静态托管服务发布。

## 数据流

1. 用户脚本先在个人收藏页发现收藏夹；本地桥接按稳定 ID 合并改名和新增项，再只扫描当前启用且可见的收藏夹。
2. 详情适配器在同一次只读页面请求中提取正文与页面初始评论；评论去除用户身份后作为未经核实的补充线索保存，原始评论不进入公开网页。
3. Bridge 校验 Host、token、面板 ID、请求大小和小红书 URL。
4. 新笔记按 ID 增量去重；失败条目单独记录，不循环重试。
5. 点点或离线证据先形成 candidate；资源评估与 audit 明确产生 pending/rejected/accepted，不配置 Agent 时也能确定性完成到诚实状态。
6. 两个正式构建器共用同一 acceptance decision，在 staging 中生成相同 `build_version` 的 Markdown 与脱敏 `site/data/knowledge.json`。
7. 双输出 journal 只在两份 staging 全部验证后交换 live；失败恢复为同一上一版。
8. 发布只在最终快照成功后按配置执行，单个 run 最多一次；`publish_failed` 保留本地新快照与远端上一版。
9. 网页在浏览器中完成搜索、筛选、排序和详情展示。

## 领域层与资源索引

采集来源和知识领域分离：小红书适配器只负责获取收藏，`domain_profile` 负责内容分类、页面叙事与资源索引。构建器把不同领域注册表编译为统一的 `resources` 结构，前端再读取领域配置提供的实体字段、分组筛选、排序、指标和权威入口。software、fitness 与 skincare 已共用这条链路，接口见 [资源索引领域接口](RESOURCE_INDEX.md)。

## 关键设计决策

- 纯静态公开站点：部署轻、成本低，也缩小了公开攻击面。
- 确定性构建器：相同输入产生相同结构，不把每日运行绑定到某个模型供应商。
- 原始证据留在本机：公开知识可以分享，账号登录态和版权材料不随之发布。
- 候选不冒充结论：`candidateKind=Skill` 只有在 accepted 且恰好一个 fresh verified resource 时才提升为 confirmed Skill。
- 同代正式输出：知识库与网页通过 journal、恢复和共享 build version 获得一致性，不声称跨目录原子 rename。
- 收藏夹优先建立主分类：默认直接反映用户自己的收藏体系；内容识别负责主题关联和纠偏建议，只有带依据的显式覆盖才跨收藏夹归档。
