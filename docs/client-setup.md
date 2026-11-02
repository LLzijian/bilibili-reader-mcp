# 客户端连接

当前版本从 GitHub 源码运行，尚未发布 npm 包。先按 [README](../README.md) 完成 npm ci、npm run build 和 setup 登录。

## 通用 MCP 配置

支持 stdio 的客户端使用本机 Node.js，参数为构建后的 dist/index.js 绝对路径：

~~~json
{"mcpServers":{"bilibili-study":{"command":"node","args":["/absolute/path/to/bilibili-study-mcp/dist/index.js"]}}}
~~~

支持 MCP 图片内容的客户端可以实际查看 get_video_frames 返回的画面；支持 prompts 的客户端可以选择 study_video。只支持文字的客户端可读取字幕，但无法检查画面内容。

如需指定现有模型，可在上述服务的 env 中设置 BILIBILI_TRANSCRIBER_CONFIG 为本地 JSON 配置文件的绝对路径；FFmpeg 不在 PATH 时设置 BILIBILI_FFMPEG_PATH。参见 [本地转写配置](local-transcriber.md)。

凭证保存于 ~/.bilibili-mcp/，不放进客户端配置或仓库。可运行 node dist/cli.js doctor --json 查看脱敏状态；node dist/cli.js check 检查在线登录状态。

Windows 二维码显示异常时，使用 BILIBILI_QR_BROWSER=1 后运行 setup，在默认浏览器扫码。源码更新后重新构建并重启 MCP 客户端。网络 Fake-IP 诊断见 [工具参考](tool-reference.md)。

代理使用 Fake-IP 时，可按需为本工具设置 BILIBILI_MEDIA_DNS=cloudflare；默认关闭，启用前需用户同意。参见 [媒体网络配置](media-network.md)。
