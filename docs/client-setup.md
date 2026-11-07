# 客户端连接

当前版本从源码运行，尚未发布 npm 包。先按 [README](../README.md) 完成 npm ci 和 npm run build；Bilibili 登录使用 setup。抖音只解析公开页面，无需 Bilibili 登录，不读取 `DOUYIN_COOKIE`；登录墙和验证码会明确失败。

## 通用 MCP 配置

支持 stdio 的客户端使用本机 Node.js，参数为构建后的 dist/index.js 绝对路径：

~~~json
{"mcpServers":{"video-reader":{"command":"node","args":["/absolute/path/to/video-reader-mcp/dist/index.js"]}}}
~~~

支持 MCP 图片内容的客户端可以实际查看 `get_video_frames` 和 `get_video_keyframes` 返回的 JPEG；支持 prompts 的客户端可选择跨平台 `read_video`（`url`、可选 `mode=outline|report`），或原 Bilibili `study_video`。只支持文字的客户端可读取逐字稿，但无法检查画面。

如需复用现有模型，可在服务的 env 中设置 `BILIBILI_TRANSCRIBER_CONFIG` 为本地 JSON 配置的绝对路径，无需重复安装托管模型。选择托管 faster-whisper 时用 setup 准备模型。ASR 调用仍需显式 `fallback_to_asr=true` 或 `force_asr=true`，默认不自动转写。参见 [本地转写配置](local-transcriber.md)。

媒体处理需自行安装 FFmpeg 和 ffprobe；默认从 PATH 查找，不在 PATH 时分别设置 `BILIBILI_FFMPEG_PATH`、`BILIBILI_FFPROBE_PATH`。工具不自动安装。配置变更后重新加载客户端。

`extract_video_clips` 返回服务器本机绝对路径，MP4 持久保存在 `~/.bilibili-mcp/clips/`，不返回 base64。远程 MCP 的路径位于服务器主机，客户端不一定能直接访问；文件由用户管理。参数与平台限制见 [工具参考](tool-reference.md)。

Bilibili 凭证保存于 `~/.bilibili-mcp/`，不放进客户端配置或仓库。运行 `node dist/cli.js doctor --json` 查看脱敏状态；`node dist/cli.js check` 检查 Bilibili 在线登录状态。Windows 二维码显示异常时，设置 `BILIBILI_QR_BROWSER=1` 后运行 setup，在默认浏览器扫码。源码更新后重新构建并重启 MCP 客户端。

代理使用 Fake-IP 时，可按需为本工具设置 `BILIBILI_MEDIA_DNS=cloudflare`；默认关闭，启用前需用户同意。参见 [媒体网络配置](media-network.md)。
