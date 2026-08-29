# 贡献指南

感谢改进 FavSense · 拾光台。项目优先接受能够提高可移植性、可核验性、安全性和无障碍体验的贡献。

## 开始之前

本项目统一要求 Node.js 20 与 Python 3.12。行为修改必须从 APPROVED Spec 和 canonical Plan 开始；真实平台、凭据和真实迁移 apply 不属于自动测试范围。

1. Fork 仓库并从 `main` 创建分支。
2. 不要提交真实 Cookie、Token、个人主页、收藏夹 ID、下载视频或抽帧图片。
3. 新增第三方资源时，必须链接可核验的权威来源；软件项目还应注明 Star 核验日期、许可证和权限风险。
4. 任何针对平台采集的改动必须保持只读、最小频率和遇风控即停。
5. 公开仓库的文件与目录名使用可打印 ASCII；中文内容写在文件内部，避免 Unicode 同形路径绕过隐私边界。

## 本地验证

Windows PowerShell 使用 `npm.cmd`，POSIX/Ubuntu CI 使用 `npm`。按改动选择最小入口，再以完整门收尾：

首次安装依赖后还需安装 Playwright Chromium：Windows 运行 `npx.cmd playwright install chromium`；Ubuntu/CI 运行 `npx playwright install --with-deps chromium`。

| 改动 | Windows 最小命令 | 完整门 |
|---|---|---|
| 收藏整理状态、候选、迁移 | `npm.cmd run test:organization` | `npm.cmd run release:check` |
| 浏览器脚本 | `npm.cmd run check:syntax`、`npm.cmd run lint:a11y`、`npm.cmd run test:site` | `npm.cmd run test:e2e`、`npm.cmd run release:check` |
| 知识库/公开输出 | `npm.cmd run test:knowledge`、`npm.cmd run test:site` | `npm.cmd run release:check` |
| Windows 安装安全 | `npm.cmd run test:windows-contracts` | Windows CI 的同名入口 |

合成 QA 服务的场景和 UX/VC 映射可由 `npm.cmd run preview:qa-fixture -- --help` 查看；Playwright 自己管理该服务，并覆盖 desktop/mobile 的 success、partial、build-failed、publish-failed、safety-stopped。测试只写合成的 `test-results/`、`playwright-report/` 与 canonical `docs/reports/`，不得收集任何私有目录。

```powershell
npm run release:check
```

该命令统一运行 Node.js 测试、收藏整理器与点点 Skill 的 Python `unittest`，并检查公开发布边界。若解释器不在 PATH，可把 `FAVSENSE_PYTHON` 指向准确的 Python 3.12 可执行文件。POSIX/CI 的完整门是 `npm run release:check`。

迁移测试只能使用 synthetic fixture 和默认 dry-run。真实迁移 apply 必须在 review brief 获用户批准后另行授权；本流水线不得读取或修改真实 `.xhs-favorites/` 数据。

使用 `npm run preview` 预览网页；服务只绑定 `127.0.0.1`。至少检查桌面、窄屏、键盘焦点和减少动态效果设置。

## Pull Request

PR 描述必须链接 APPROVED Spec、canonical Plan、RED/GREEN、Review、QA、Audit、Review brief 与回滚说明。行为修改严格遵守 Spec → Plan → TDD → Review → QA → Audit → Brief → 用户批准 → PR；避免在同一个 PR 中混合无关重构。
