# redbook 适配说明

## 安装策略

`redbook` 需要 Node.js 22 或更高版本。其 npm 安装脚本会创建 Claude 技能链接并修改依赖，因此不要未经检查直接全局安装。

优先在隔离目录中跳过安装脚本：

```powershell
New-Item -ItemType Directory -Force ".xhs-tools" | Out-Null
npm.cmd install --prefix ".xhs-tools" --ignore-scripts @lucasygu/redbook
```

安装后先运行包内 CLI 的 `--help` 与 `whoami`。如果跳过安装脚本导致当前版本无法工作，应停止并检查上游 `scripts/postinstall.js`，不要直接重新启用脚本。

若用户已经自行全局安装且 `redbook whoami` 正常，可直接复用。

## Chrome 150 兼容补丁

仅在满足以下全部条件时应用：

- Windows 上使用 Chrome 150；
- 项目隔离安装的 `redbook` 版本严格等于 `0.8.1`；
- `whoami` 出现默认配置启动超时，或 CDP 返回 `Network.getAllCookies` 不存在；
- 用户已明确授权修改项目隔离依赖。

先检查，不写文件：

```powershell
node "<skill-dir>\scripts\patch-redbook-cdp.mjs" `
  --workspace "<工作目录>" --check
```

检查通过后应用：

```powershell
node "<skill-dir>\scripts\patch-redbook-cdp.mjs" `
  --workspace "<工作目录>"
```

补丁会把 CDP Cookie 方法改为 `Storage.getCookies`，并在默认配置启动超时时改用临时配置重试。它会在原文件旁创建 `.xhs-favorites-organizer.bak` 备份，不输出 Cookie。

需要回滚时：

```powershell
node "<skill-dir>\scripts\patch-redbook-cdp.mjs" `
  --workspace "<工作目录>" --restore
```

升级或重新安装 `redbook` 后，先重新检查版本，不要自动重放旧补丁。

## Windows 登录

1. 确保用户已在 Chrome 登录 `xiaohongshu.com`。
2. 执行 `redbook whoami`。
3. 若 Chrome 127+ Cookie 解密失败，让用户保存工作并自行关闭 Chrome，然后重试。
4. 仍失败时停止自动化，让用户选择是否手工处理认证。

不要在 Codex 对话、脚本参数、终端历史或项目文件中粘贴 `a1`、`web_session` 等 Cookie。

## 允许的只读命令

```powershell
redbook whoami
redbook favorites --json
redbook favorites "<public-user-id>" --json
redbook boards --json
redbook board "<board-url-or-id>" --json
redbook read "<note-url>" --json
```

每次用户主动触发的增量整理只运行一次 `favorites --json`，不使用 `--all`。完整历史导入需要用户单独授权，并应采用分批、延迟和可恢复的方案。

## 禁止自动执行的命令

以下命令会改变小红书账号或公开内容，不得由本技能默认执行：

```text
collect, uncollect, like, delete, comment, reply, batch-reply, post
```

除“允许的只读命令”外，任何新增的上游命令都按禁止处理，直到人工确认其副作用。

## 兼容性

`organize.mjs` 支持常见的裸数组、`notes`、`items`、`list`、`data.notes`、`data.items` 和 `data.list` 结构，并能读取 `note_card` 包装对象。若上游字段变化，先保存一份已脱敏的小样本并更新解析器；不要删除旧 catalog。
