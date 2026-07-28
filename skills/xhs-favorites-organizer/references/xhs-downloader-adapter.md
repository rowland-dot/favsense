# XHS-Downloader 适配说明

## 浏览器用户脚本

使用官方仓库 `JoeanAmier/XHS-Downloader` 已审查提交 `d805ebdd3db53f68137bc2b7a6ed118ce572d09b` 中的用户脚本。Chrome 138+ 与 Tampermonkey 5.3+ 需要在扩展详情中开启“允许用户脚本”。关闭该脚本的自动更新；升级前重新审查新提交。

官方脚本文件名是 `XHS-Downloader.js`，部分 Chrome 不会自动显示安装页。遇到这种情况：

1. 打开 Tampermonkey 控制面板的 `Utilities`；
2. 找到 `Import from URL`；
3. 输入固定提交的 raw URL：`https://raw.githubusercontent.com/JoeanAmier/XHS-Downloader/d805ebdd3db53f68137bc2b7a6ed118ce572d09b/static/XHS-Downloader.js`；
4. 确认安装。

保持“自动滚动页面”关闭。手动滚动后再提取已加载的收藏或专辑链接。

## 本地详情读取器

在工作目录中隔离安装，不写入全局 Python 环境：

```powershell
git clone --depth 1 https://github.com/JoeanAmier/XHS-Downloader.git `
  ".xhs-tools\XHS-Downloader"

git -C ".xhs-tools\XHS-Downloader" fetch --depth 1 origin `
  d805ebdd3db53f68137bc2b7a6ed118ce572d09b
git -C ".xhs-tools\XHS-Downloader" checkout --detach `
  d805ebdd3db53f68137bc2b7a6ed118ce572d09b

$env:UV_CACHE_DIR = "<工作目录>\.xhs-tools\uv-cache"
$env:UV_PYTHON_INSTALL_DIR = "<工作目录>\.xhs-tools\uv-python"
uv sync --locked --no-dev --python "<Python-3.12-path>"
```

在 `.xhs-tools\XHS-Downloader` 中执行 `uv sync`。要求 Python 3.12 或更高版本。

详情读取器必须使用：

- `download=False`
- `record_data=False`
- `image_download=False`
- `video_download=False`
- `live_download=False`
- `script_server=False`

不要使用项目已经失效的“从浏览器读取 Cookie”功能，也不要配置手工 Cookie。

`fetch-xhs-details.py` 会拒绝其他提交或包含已跟踪文件修改的 checkout，并在发出请求前用启用证书验证的客户端替换上游客户端。任何一条详情失败都会立即终止当前批次，不继续请求或自动重试。

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
  ]
}
```

输出不得包含原始查询参数、`xsec_token` 或 Cookie。批次采用原子失败语义：任何一条详情不可用时立即停止，不输出部分 JSON，也不写 catalog 或日报。剪贴板保持不变，等待用户稍后重新运行。
