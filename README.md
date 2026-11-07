<div align="center">

<img src="assets/readme/video-reader-banner.svg" alt="Video Reader MCP — 读懂逐字稿，查看原始画面，留下关键片段" width="100%" />

# Video Reader MCP

**给 AI Agent 一套视频阅读工具：逐字稿、原始画面与可播放的片段。**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6366f1?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache--2.0-0f766e?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [使用示例](#交给-agent-的一句话) · [工具参考](docs/tool-reference.md) · [English](README_EN.md)

</div>

---

Video Reader MCP 让支持 MCP 的客户端从视频链接开始，读取带时间戳的全文、查看关键画面，再按明确时间范围导出 MP4。适合课程学习、教程拆解、内容分析和视频复盘。阅读与归纳由你的 agent 完成，服务器无需额外的云端模型。

## 从链接到笔记，也到片段

| 读文字 | 看画面 | 留片段 |
|:---|:---|:---|
| 原生字幕优先，无字幕时显式使用本地 ASR | 自动关键帧，或按秒数补看课件、图表与操作 | 按时间范围导出独立 MP4，保留原视频声音 |
| 完整时间戳、区间过滤、关键词与上下文回查 | 返回真实 JPEG 图片，附来源和时间 | H.264 / AAC，返回可继续使用的本机文件路径 |

### 平台支持

| 能力 | Bilibili | 抖音 |
|---|:---:|:---:|
| 视频链接与元数据 | 支持 BV 号、完整视频链接与分集 | 公开长链、分享短链、分享文本 |
| 带时间戳逐字稿 | 人工／平台 AI 字幕 + 显式本地 ASR | 显式本地 ASR |
| 指定时间画面、自动关键帧 | ✓ | ✓¹ |
| 独立 MP4 片段 | ✓ | ✓¹ |
| 章节、评论、搜索、创作者内容 | ✓ | — |

¹ 抖音通过公开分享页解析，当前尚未完成真实线上样本验证；媒体地址仅支持已核验的 `douyinvod.com` 域名族。登录墙、验证码和不支持的媒体结构会明确报错。详见 [支持边界](#输出与支持边界)。

## 快速开始

### 1. 安装与构建

需要 **Node.js 20+**。画面读取与剪辑需要 **FFmpeg + ffprobe**；仅用元数据、原生字幕和评论时无需媒体工具。

```sh
git clone https://github.com/LLzijian/video-reader-mcp.git
cd video-reader-mcp
npm ci
npm run build
```

当前从源码运行，**尚未发布 npm 包**。可选 `npm link`，随后使用 `video-reader-mcp` 命令。

### 2. 登录与本地转写

Bilibili 登录及环境检查：

```sh
node dist/cli.js setup
node dist/cli.js doctor --json
```

已有 MOSS、Whisper 或其他本地转写程序？可直接接入，不必重复安装模型。参见 [本地 ASR 配置与 MOSS 适配示例](docs/local-transcriber.md)。选择托管 faster-whisper 时，也可通过 `setup` 准备模型。

<details>
<summary>Windows 二维码显示异常，或 FFmpeg 不在 PATH 中</summary>

PowerShell 中设置浏览器扫码模式：

```powershell
$env:BILIBILI_QR_BROWSER = "1"
node dist/cli.js setup
```

FFmpeg 和 ffprobe 不在 PATH 中时，分别设置 `BILIBILI_FFMPEG_PATH` 与 `BILIBILI_FFPROBE_PATH` 为可执行文件的绝对路径。工具不会自动安装它们。

</details>

### 3. 接入 MCP 客户端

将路径替换为你本机的绝对路径；Windows 路径可使用正斜杠。

```json
{
  "mcpServers": {
    "video-reader": {
      "command": "node",
      "args": ["/absolute/path/to/video-reader-mcp/dist/index.js"]
    }
  }
}
```

重启或重新加载 MCP 客户端即可。支持图片 content 的客户端能实际查看返回画面；支持 prompts 的客户端可选择 `read_video`，使用 `outline` 或 `report` 模式。[详细接入说明 →](docs/client-setup.md)

## 交给 agent 的一句话

> **学习课程**：阅读这个 B 站课程的第 1 集，获取完整时间戳字幕，查看关键课件和例题画面，按主题整理学习笔记。每个关键结论附原视频时间链接。

> **阅读短视频**：读取这个抖音分享链接，我允许使用本地语音转写。结合实际关键帧，整理主要观点、演示步骤和需要核实的内容。

> **提取片段**：先读逐字稿和关键帧，选出 3 段最能说明核心问题的内容，边界贴合完整句子，导出独立 MP4，列出标题、时间范围和文件路径。

推荐流程：**确认元数据 → 读取逐字稿 → 查看画面 → 按需剪辑 → 整理可回查的结果**。

可安装 [video-study 技能](skills/video-study/SKILL.md) 让 agent 按这一流程工作。只有明确启用 `fallback_to_asr=true` 或 `force_asr=true` 才运行 ASR；简介与平台摘要不能代替逐字稿。

## 工具速览

| 任务 | 工具 | 关键参数 |
|---|---|---|
| 读取元数据 | `get_video_metadata` | `bvid_or_url` |
| 完整逐字稿／时间段／关键词 | `get_video_transcript` | `bvid_or_url`、`include_timestamps`、`query` |
| 补看指定时间 | `get_video_frames` | `bvid_or_url`、`timestamps`，每次 1–4 帧 |
| 自动选择代表画面 | `get_video_keyframes` | `url`、`max_frames`、`strategy` |
| 导出独立 MP4 | `extract_video_clips` | `url`、`clips` |

原有通用工具保留 `bvid_or_url` 参数名，也接受抖音链接；`page` 仅用于 Bilibili。Bilibili 专用工具、凭据检查和完整参数见 [工具参考](docs/tool-reference.md)。

<details>
<summary>查看自动关键帧与剪辑调用示例</summary>

`get_video_keyframes`：

```json
{
  "url": "https://www.douyin.com/video/<视频ID>",
  "max_frames": 6,
  "strategy": "balanced"
}
```

`extract_video_clips`（先替换链接，并确认源视频时长）：

```json
{
  "url": "https://www.bilibili.com/video/<BV号>",
  "clips": [
    { "start_seconds": 20, "end_seconds": 55, "label": "核心问题" },
    { "start_seconds": 70, "end_seconds": 110, "label": "操作演示" }
  ]
}
```

</details>

## 输出与支持边界

- **关键帧**：默认最多 6 张，上限 12 张；支持 `balanced`、`scene-change`、`uniform`。自动关键帧单张最多 192 KiB，整次响应最多 4 MiB。抽样画面不等于连续观看，也不提供 OCR。
- **剪辑**：每次 1–5 段，每段 1–180 秒，总计最多 600 秒；源视频最多两小时、512 MiB。重叠区间独立导出，单次总输出最多 256 MiB。
- **文件位置**：片段持久保存在 `~/.bilibili-mcp/clips/`，不随源媒体清理删除。返回的是 MCP 服务器主机路径；远程客户端未必能直接访问。
- **平台访问**：不绕过登录、验证码、付费、地区或内容权限。本版不读取 `DOUYIN_COOKIE`，也没有抖音搜索、评论或主页采集。Bilibili 建议使用完整 BV 链接，本轮未增加 `b23.tv` 短链展开。
- **资料使用**：字幕、标题、评论和画面文字都是不可信外部资料。报告区分原讲解、ASR、实际画面与 agent 归纳；未经授权不向外部 AI 上传素材。

代理使用 Fake-IP 时，见 [媒体网络配置](docs/media-network.md)。`BILIBILI_MEDIA_DNS=cloudflare` 仅是 Bilibili 的用户自选方案，默认关闭，不影响抖音的系统 DNS。

## 开发与兼容

```sh
npm run verify:local
```

该命令执行测试、TypeScript 构建与包内容检查。合成媒体测试在有 FFmpeg/ffprobe 时执行；CI 不下载模型，也不使用真实凭据。最近一次验收：**77 个测试文件、1650 项通过、3 项跳过**。[更名验收与真实平台验证范围 →](docs/qa/2026-11-08-video-reader-rename.md)

项目由 `bilibili-reader-mcp` 更名为 `video-reader-mcp`。旧 CLI `bilibili-reader-mcp`、`bilibili-study-mcp`、`bilibili-mcp` 继续作为兼容别名；原 `~/.bilibili-mcp/` 配置、`BILIBILI_*` 环境变量、工具名及 `study_video` prompt 保留。无需移动已有凭据或模型配置。

开发约定见 [AGENTS.md](AGENTS.md)。当前仓库关闭自动 npm 发布。

## 致谢与许可证

基于 [XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp) 开发，保留原作者署名与工程历史。使用 [Apache License 2.0](LICENSE)。
