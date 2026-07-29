# 独立运行链路

```text
本地“同步设置”页点击“开始整理”
  -> 回环服务确认请求来自 127.0.0.1:8766
  -> 普通 Chrome 打开第一个启用面板
  -> Tampermonkey 读取已加载链接并提交到 127.0.0.1
  -> 服务按 config 顺序让同一标签页依次访问其余面板
  -> catalog 以 note ID 全局去重、保留来源面板
  -> 固定版本 XHS-Downloader 只读取新增详情
  -> build-knowledge-base.mjs 生成 Obsidian 知识库
  -> build-public-site.mjs 生成脱敏网页数据
  -> 最后一个已启用面板完成后，可选发布 site/ 到 Hugging Face Static Space
  -> 本地设置页显示完成结果并刷新知识库
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

运行链路不调用 Codex App、Claude、浏览器控制插件、剪贴板或云端 LLM，也不创建每日或 Windows 开机整理任务。

## 两种扫描模式

- `incremental`：只读取页面顶部稳定出现的条目，每个面板最多 60 篇，用于用户主动触发的增量整理。
- `history`：滚动加载，每个面板最多 200 篇，用于一次性回溯；不可设为每日任务。

任何模式检测到验证码、300031、访问频繁或安全限制都会停止，不自动重试。媒体下载使用全局单实例锁；任一批次触发限制后会写入私有安全停止标记，所有后续收藏夹同步均拒绝再次启动媒体请求，直至操作者确认平台状态恢复并清除该私有标记。

## 数据状态

- `.xhs-favorites/catalog.json`：脱敏后的原始资料与来源面板。
- `.xhs-favorites/runs/*.json`：每个面板的运行状态；不含临时链接。
- `xhs-favorites/YYYY-MM-DD.md`：同步日报。
- `knowledge-base/`：Obsidian 可直接打开的知识体系。

## 可移植性

同步和构建由 PowerShell、Python、Node.js、Tampermonkey 与 Windows Task Scheduler 完成。Agent 只可选地维护策展 JSON，因此 Claude Code、Codex CLI、Codex App 或无 Agent 环境均可使用同一套项目文件。
