# 独立运行链路

```text
Windows 计划任务（21:00，仅当前用户登录时）
  -> run-daily.ps1 启动本地回环服务
  -> 普通 Chrome 打开第一个启用面板
  -> Tampermonkey 读取已加载链接并提交到 127.0.0.1
  -> 服务按 config 顺序让同一标签页依次访问其余面板
  -> catalog 以 note ID 全局去重、保留来源面板
  -> 固定版本 XHS-Downloader 只读取新增详情
  -> build-knowledge-base.mjs 生成 Obsidian 知识库
```

运行链路不调用 Codex App、Claude、浏览器控制插件、剪贴板或云端 LLM。

## 两种扫描模式

- `daily`：只读取页面顶部稳定出现的条目，每个面板最多 60 篇，用于日常增量。
- `history`：滚动加载，每个面板最多 200 篇，用于一次性回溯；不可设为每日任务。

任何模式检测到验证码、300031、访问频繁或安全限制都会停止，不自动重试。

## 数据状态

- `.xhs-favorites/catalog.json`：脱敏后的原始资料与来源面板。
- `.xhs-favorites/runs/*.json`：每个面板的运行状态；不含临时链接。
- `xhs-favorites/YYYY-MM-DD.md`：同步日报。
- `knowledge-base/`：Obsidian 可直接打开的知识体系。

## 可移植性

同步和构建由 PowerShell、Python、Node.js、Tampermonkey 与 Windows Task Scheduler 完成。Agent 只可选地维护策展 JSON，因此 Claude Code、Codex CLI、Codex App 或无 Agent 环境均可使用同一套项目文件。
