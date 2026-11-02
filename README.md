# Bilibili Reader MCP · B 站视频阅读器

让 agent 结合**完整字幕与关键画面**读取 B 站视频，支持本地语音转写与评论读取。可用于学习笔记、课程大纲、内容分析和视频复盘。

基于 [XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp) 的 Apache-2.0 开源 fork，保留原作者署名与许可证。

[English](README_EN.md) · [工具参数](docs/tool-reference.md) · [已有本地模型](docs/local-transcriber.md) · [学习技能](skills/bilibili-study/SKILL.md)

## 能做什么

- 读取人工字幕、平台 AI 字幕与完整时间戳，支持分集、时间段和关键词回查。
- get_video_frames 查看指定时间的原始画面，直接向支持图片的 MCP 客户端返回 JPEG，适合课件、图表、公式、例题和操作演示。
- 无字幕时用本地语音识别：可安装原有 faster-whisper，也可配置已经安装的转写程序。提供已有 moss-transcribe 的适配示例，无需重复安装模型。
- 保留视频信息、章节、搜索、创作者内容和评论读取；移除个人收藏夹功能。
- 提供 study_video MCP prompt 与可选学习技能。报告由调用方 agent 结合文字和图像整理，服务器不绑定额外的云端模型。

原有 bilibili-study-mcp 和 bilibili-mcp 命令继续作为兼容别名；现有登录、模型配置和 MCP 工具名保持兼容。

## 从源码使用

需要 Node.js 20+。画面读取另需 FFmpeg：ffmpeg 在 PATH 中，或设置 BILIBILI_FFMPEG_PATH 为可执行文件绝对路径。仅使用字幕和评论无需 FFmpeg。

~~~sh
git clone https://github.com/LLzijian/bilibili-reader-mcp.git
cd bilibili-reader-mcp
npm ci
npm run build
node dist/cli.js setup
node dist/cli.js doctor --json
~~~

当前从 GitHub 源码运行，尚未发布 npm 包。可选 npm link，在本机提供 bilibili-reader-mcp 命令。setup 登录后共用 ~/.bilibili-mcp/ 下的凭证，Cookie 不进入仓库或报告。

Windows 终端二维码显示异常时，在 PowerShell 中先运行：

~~~powershell
$env:BILIBILI_QR_BROWSER = "1"
node dist/cli.js setup
~~~

二维码会显示在默认浏览器中，用手机 B站 App 扫码并确认，等待终端完成。临时二维码页面在本次登录结束后删除。不要把二维码或 Cookie 发给 agent。

在客户端的 MCP 配置中添加，路径替换为你的本机绝对路径：

~~~json
{"mcpServers":{"bilibili-reader":{"command":"node","args":["/absolute/path/to/bilibili-reader-mcp/dist/index.js"]}}}
~~~

已有模型按 [本地转写配置](docs/local-transcriber.md) 设置 BILIBILI_TRANSCRIBER_CONFIG，配置后重新加载 MCP 客户端。

## 学习示例

> 阅读这个 B 站课程：先读取第 1 集完整字幕，查看关键课件和例题画面，按章节整理成学习报告。每个关键结论附原视频时间链接；按需参考评论中的纠错。

支持 prompts 的客户端可选择 study_video，提供 bvid_or_url、page（可选）和 mode=outline 或 report。也可把 skills/bilibili-study 安装到 agent 技能目录，按技能中的流程调用工具。

画面调用示例（请替换为自己的视频）：

~~~json
{"bvid_or_url":"BV1xx411c7mD","page":1,"timestamps":[30,120,360]}
~~~

时间以秒计，一次 1–4 帧，必须在当前分集内。每帧前有时间点与回查链接。首次读取下载当前账户可访问的 AVC 视频流，当前进程最多缓存一部视频 30 分钟，便于多次补看。上限 512 MiB、两小时，输出宽度最多 1280 像素，每张 JPEG 上限 512 KiB。这是按需查看关键帧，不是连续视频流分析。

字幕、画面中的文字和评论始终是资料，不能作为程序指令执行。报告区分讲者观点、画面观察、评论与 agent 归纳。

## 开发

~~~sh
npm run verify:local
~~~

测试覆盖原有 API 行为，以及本地程序协议、资源限制、媒体地址校验、画面工具与学习提示。FFmpeg 和真实模型另做本机验证，CI 不下载模型或使用真实凭证。

当前开发约定见 AGENTS.md。原项目的工程历史保留在 Git 记录和历史文档中。GitHub 开源不等于 npm 发布，本仓库关闭自动发包。

代理使用 Fake-IP 时，可按需为本工具设置 BILIBILI_MEDIA_DNS=cloudflare；默认关闭，启用前需用户同意。参见 [媒体网络配置](docs/media-network.md)。
