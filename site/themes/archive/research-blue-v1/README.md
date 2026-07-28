# Research Blue v1（已归档）

这是 2026-07-28 创建的首版“研究工作台”蓝紫配色快照。当前网页不会导入或链接本目录中的任何文件。

如需恢复，把本目录中的四个文件复制回 `site/`：

```powershell
Copy-Item ".\site\themes\archive\research-blue-v1\styles.css" ".\site\styles.css" -Force
Copy-Item ".\site\themes\archive\research-blue-v1\app.js" ".\site\app.js" -Force
Copy-Item ".\site\themes\archive\research-blue-v1\index.html" ".\site\index.html" -Force
Copy-Item ".\site\themes\archive\research-blue-v1\site-config.js" ".\site\site-config.js" -Force
```

恢复后重新运行测试。不要在当前主题中通过 `<link>`、`@import` 或脚本加载此归档。
