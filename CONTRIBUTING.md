# 贡献指南

感谢改进 FavSense · 拾光台。项目优先接受能够提高可移植性、可核验性、安全性和无障碍体验的贡献。

## 开始之前

1. Fork 仓库并从 `main` 创建分支。
2. 不要提交真实 Cookie、Token、个人主页、收藏夹 ID、下载视频或抽帧图片。
3. 新增第三方资源时，必须链接可核验的权威来源；软件项目还应注明 Star 核验日期、许可证和权限风险。
4. 任何针对平台采集的改动必须保持只读、最小频率和遇风控即停。

## 本地验证

```powershell
npm test
npm run verify
python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"
```

使用 `npm run preview` 预览网页；服务只绑定 `127.0.0.1`。至少检查桌面、窄屏、键盘焦点和减少动态效果设置。

## Pull Request

PR 描述应说明：问题、解决方式、验证证据、安全/隐私影响，以及界面变化截图。避免在同一个 PR 中混合无关重构。
