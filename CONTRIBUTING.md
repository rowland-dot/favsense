# 贡献指南

感谢改进 FavSense · 拾光台。项目优先接受能够提高可移植性、可核验性、安全性和无障碍体验的贡献。

## 开始之前

1. Fork 仓库并从 `main` 创建分支。
2. 不要提交真实 Cookie、Token、个人主页、收藏夹 ID、下载视频或抽帧图片。
3. 新增第三方资源时，必须链接可核验的权威来源；软件项目还应注明 Star 核验日期、许可证和权限风险。
4. 任何针对平台采集的改动必须保持只读、最小频率和遇风控即停。
5. 公开仓库的文件与目录名使用可打印 ASCII；中文内容写在文件内部，避免 Unicode 同形路径绕过隐私边界。

## 本地验证

```powershell
npm run release:check
```

该命令统一运行 Node.js 测试、收藏整理器与点点 Skill 的 Python `unittest`，并检查公开发布边界。需要 Node.js 20+ 与 Python 3.12+；若解释器不在 PATH，可把 `FAVSENSE_PYTHON` 指向准确的 Python 可执行文件。Windows PowerShell 使用 `npm.cmd run release:check`；POSIX/CI 使用 `npm run release:check`。收藏整理闭环的快速回归入口是 `npm.cmd run test:organization`。

使用 `npm run preview` 预览网页；服务只绑定 `127.0.0.1`。至少检查桌面、窄屏、键盘焦点和减少动态效果设置。

## Pull Request

PR 描述必须链接 APPROVED Spec、canonical Plan、RED/GREEN、Review、QA、Audit、Review brief 与回滚说明。行为修改严格遵守 Spec → Plan → TDD → Review → QA → Audit → Brief → 用户批准 → PR；避免在同一个 PR 中混合无关重构。
