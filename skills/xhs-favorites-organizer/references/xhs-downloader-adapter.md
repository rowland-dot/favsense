# XHS-Downloader 适配说明

## 本地详情读取器

`setup-autosync.ps1` 会先调用 `setup-xhs-downloader.ps1`，从官方仓库隔离准备已审查提交 `d805ebdd3db53f68137bc2b7a6ed118ce572d09b`，再生成任何本机 Bridge 凭据。安装器只使用锁文件和 Python 3.12，在 `.xhs-tools/` 内完成临时 checkout 与依赖安装，全部成功后才把它提升为正式运行时。

已有 checkout 必须同时满足：官方 HTTPS origin、提交号完全一致、工作树无修改或未跟踪文件；否则安装会停止且不会覆盖目录。升级前必须先审查并同步修改安装器、详情读取器、媒体读取器和本文中的固定提交。

详情读取器必须使用：

- `download=False`
- `record_data=False`
- `image_download=False`
- `video_download=False`
- `live_download=False`
- `script_server=False`

不要使用项目已经失效的“从浏览器读取 Cookie”功能，也不要配置手工 Cookie。

`fetch-xhs-details.py` 会拒绝其他提交或包含已跟踪文件修改的 checkout，并在发出请求前用启用证书验证的客户端替换上游客户端。Bridge 把当前页面中的临时签名链接直接写入详情子进程的标准输入，不经过剪贴板或人工复制。普通详情缺口会以脱敏失败项返回；遇到验证码、`300031`、访问频繁或安全限制时，当前及剩余条目统一标记为 `safety stop` 并立即停止请求。

## 数据契约

`fetch-xhs-details.py` 从标准输入读取空白分隔的作品链接，输出：

```json
{
  "notes": [
    {
      "note_id": "stable-note-id",
      "title": "title",
      "description": "description",
      "type": "视频",
      "tags": "tag-a tag-b",
      "author": "nickname",
      "webUrl": "https://www.xiaohongshu.com/explore/stable-note-id"
    }
  ],
  "failures": [
    {
      "note_id": "stable-note-id",
      "reason": "detail unavailable"
    }
  ]
}
```

输出不得包含原始查询参数、`xsec_token` 或 Cookie。Bridge 只接收成功详情与脱敏失败分区；安全停止后不继续请求、排队媒体或发布。
