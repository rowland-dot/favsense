# 独立运行链路

```text
本地“同步设置”页点击“开始整理”
  -> 回环服务确认请求来自 127.0.0.1:8766
  -> Bridge 从 SOP 私有 cdp-port.txt 解析当前动态端口
  -> Bridge 在已运行的 SOP 扫描浏览器中打开第一个启用面板
  -> Tampermonkey 读取已加载链接并提交到 127.0.0.1
  -> 服务按 config 顺序让同一标签页依次访问其余面板
  -> catalog 以 note ID 全局去重、保留来源面板
  -> 固定版本 XHS-Downloader 只读取新增详情
  -> 最后一个面板完成后只保存核心 checkpoint，并封存本轮稳定 note ID 范围
  -> 若 diandian.enabled 且 v1.2 CDP 可用：Tampermonkey 每篇分享/复制一次，Bridge 新建 fresh about:blank 目标并把无查询 plain URL 交给外部 Skill ask
  -> 外部 Skill 负责真实鼠标与原生输入；Bridge 负责导航、安全/登录检查、严格新回复稳定性、保存确认与成功关页
  -> 每篇成功原子保存为 captured；真实失败为 failed，未尝试剩余项为 batch_aborted
  -> 无法附着且未触发安全限制：只使用已有缓存进入音频/OCR/评论证据回退，不伪造成功
  -> 确定性编排 candidate -> evidence -> resource -> audit；缺证据保持 pending，只有完整当前记录进入 accepted
  -> 关键词候选只输出 candidateKind；confirmed Skill 必须恰好关联一个 verified resource
  -> build-organization-snapshot.mjs 生成同一 build_version 的正式知识库与脱敏网页快照
  -> 两份 staging 全部验证并交换成功后，按配置最多发布一次到 Hugging Face Static Space
  -> 本地设置页显示真实阶段结果；captured/pending 证据只在鉴权待审核 overlay 显示
```

视频分析使用独立的离线工作任务，不阻塞收藏同步：

```text
本地视频缓存
  -> FFmpeg 临时提取音频
  -> faster-whisper 离线转写
  -> 先基于完整转写生成摘要和候选实体
  -> 名称明确：直接核验官方来源，不抽帧
  -> 名称缺失或指向屏幕：每 5 秒一帧 + 转场帧
  -> 缺失事实补齐：立即停止视频检查，转官方来源核验
  -> 仍未确认：只对可疑时间段每 0.5 秒抽帧
  -> 写入策展 JSON 后重建知识库与网页
```

首次启用离线转写时运行 `scripts/setup-transcription.ps1`；模型下载完成后，日常处理不依赖云端模型 API。`scripts/run-video-analysis.ps1` 默认按文件体积从小到大处理并逐条输出进度。默认只转写；确认缺失事实后才使用 `-PrepareVisualEvidence`，每次仅生成一个条目的一个短窗口。找到技能名、仓库或缺失事实后立即结束该条，不再读取后续音频或画面；没有找到才从记录的下一时间点继续。若内容声称来自 GitHub、开源项目或代码仓库，产品名与仓库身份必须分开核验：只有获得可唯一定位的 `owner/repo` 才能停止仓库视觉检查，之后仍需从官方仓库独立检查源码、许可证和项目类型。

核心同步、去重、候选生成与本地构建不调用 Codex App、Claude 或云端模型 API，也不创建每日或 Windows 开机整理任务。点点增强仅在用户显式开启时由同一个按钮继续执行，复用 SOP 扫描浏览器的登录态；临时签名链接只在 Tampermonkey→Bridge 请求和内存校验中存在，传给外部 transport 前必须 canonicalize 为无查询 plain URL。它不是核心数据依赖，失败不得撤销已经完成的 catalog；正式输出只在最终 curation 门后构建一次。

首次 setup 固定检查 SOP 扫描 profile 内是否已安装 Tampermonkey。SOP 通道已活时不得重新启动浏览器；通道未启动时只允许调用 SOP 的 `启动扫描浏览器.bat` 一次。未安装扩展时，通过该动态 CDP 通道打开官方扩展商店与小红书登录页，停止并提示用户完成后重跑；此时不启动 Bridge、不轮换凭据，也不发放会过期的用户脚本安装能力。检测到扩展后，setup 才启动 Bridge 并在同一个 SOP 浏览器中打开一次性安装源。不得复制主浏览器的 profile、Cookie 或扩展目录，也不得创建 FavSense 第二 profile。

点点的单篇工作流与私有保存器从 `diandian.skill_path` 指向的 `xhs-diandian-summarize-note` Skill 加载。启用点点时必须显式填写该路径。桥接只接受名称匹配的 `SKILL.md`、版本绑定的 `release.json`、严格声明式 `runtime/browser-contract.json` 和 API 1 保存器；v1.2 还必须精确声明 `scripts/cdp_transport.py`，其 `ask` 负责真实鼠标/原生输入。Bridge 每次从 SOP 的 `.secrets/cdp-port.txt` 重新解析动态回环端点，且只开放 `call` / `evaluate` session，不调用 Cookie/Storage 命令。fresh target、安全停止、稳定笔记 ID、严格新回复、一次提交、保存后关页和停批防线仍由 organizer 强制。

## 两种扫描模式

- `incremental`：只读取页面顶部稳定出现的条目，每个面板最多 60 篇，用于用户主动触发的增量整理。
- `history`：滚动加载，每个面板最多 200 篇，用于一次性回溯；不可设为每日任务。

任何模式检测到验证码、300031、访问频繁或安全限制都会停止，不自动重试。媒体下载使用全局单实例锁；任一批次触发限制后会写入私有安全停止标记，所有后续收藏夹同步均拒绝再次启动媒体请求，直至操作者确认平台状态恢复并清除该私有标记。

## 一次性收藏夹范围

本地受信工作台或操作者可以向 `POST /sync/start` 提交一次性运行范围：

```json
{
  "board_ids": ["从本机 /boards 响应中选择的已启用收藏夹 ID"],
  "mode": "history"
}
```

- `board_ids` 必须来自同一回环服务的已认证 `GET /boards` 响应，只能包含当前已启用且可见的收藏夹；不得把真实 ID 写入公开文档、站点或仓库。
- 范围只写入本轮私有运行状态，不修改 `config/xhs-favorites.json` 中的长期收藏夹开关。
- 本轮仍先刷新完整收藏夹清单，以同步改名和新增收藏夹；刷新完成后，扫描、点点计划、下一收藏夹跳转和完成判断都只使用启动时指定的冻结范围。
- 请求体 `{}` 保持普通工作台行为：刷新后整理全部已启用收藏夹。目标收藏夹需要完整加载时使用 `mode: "history"`。
- 普通收藏夹批量计划自动跳过已有且通过记录格式校验的总结；本地详情页的“重新总结”是精确单篇 local-only force rerun，失败保留旧记录，只有新回复验证并原子保存成功后才替换。
- 目标收藏夹在刷新后变为不可见或被关闭时，本轮直接失败，不扩大到其他收藏夹。出现验证码、`300031`、访问频繁或安全限制时整轮停止，不继续下一个条目或收藏夹。

## 数据状态

- `.xhs-favorites/catalog.json`：脱敏后的原始资料与来源面板。
- `.xhs-favorites/runs/*.json`：每个面板的运行状态；不含临时链接。
- `.xhs-favorites/diandian-summaries/<note-id>.json`：可选点点回复；只含稳定 ID、标题和清理后的正文，不含来源链接或登录凭据。
- `.xhs-favorites/diandian-rerun-report.json`：本轮点点覆盖统计和待补证 ID；不含临时链接。
- `.xhs-favorites/organization-state/`：正交 run/note 状态和恢复依据；状态使用 `captured`、`failed`、`batch_aborted`、`pending_review`、`accepted` 等封闭枚举。
- `.xhs-favorites/resource-assessments.json`：候选、歧义、缺失或过期资源的私有评估；只有完整 verified 快照进入正式资源注册表。
- `xhs-favorites/YYYY-MM-DD.md`：同步日报。
- `knowledge-base/`：Obsidian 可直接打开的知识体系。

`captured` 只表示点点回复已按当前正文版本安全保存；`pending` 表示还缺审核、证据或资源；`accepted` 才能进入正式知识库和公开页面。`candidateKind="Skill"` 是候选提示，不是 `confirmed Skill`。本地待审核 overlay 只经鉴权 loopback 返回清理后的摘要、证据方法和 blocker；公共 Origin 不请求也不渲染该区域。

## 可移植性

同步和构建由 PowerShell、Python、Node.js 与 Tampermonkey 完成。Agent 只可选地维护策展 JSON，因此 Claude Code、Codex CLI、Codex App 或无 Agent 环境均可使用同一套项目文件；系统不会创建 Windows 计划任务或开机启动项。
