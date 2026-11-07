<div align="center">

<img src="assets/readme/video-reader-banner.svg" alt="Video Reader MCP — Read the words. See the frames. Keep the moments." width="100%" />

# Video Reader MCP

**Give your AI agent transcripts, original frames, and playable video clips.**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6366f1?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-Apache--2.0-0f766e?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [Try it with your agent](#try-it-with-your-agent) · [Tool reference](docs/tool-reference.en.md) · [简体中文](README.md)

</div>

---

Video Reader MCP lets MCP clients start with a video link, read the full timestamped transcript, inspect selected frames, and export MP4 clips from explicit time ranges. Use it for study notes, tutorials, content analysis, and video reviews. Your agent handles interpretation; the server needs no additional cloud model.

## From links to notes — and clips

| Read the words | See the frames | Keep the moments |
|:---|:---|:---|
| Native subtitles first, with explicitly permitted local ASR | Automatic keyframes or exact-time views of slides, charts, and demonstrations | Independent MP4 clips with source audio when available |
| Timestamps, time ranges, keyword matches, and context | Actual JPEG content with source references and seconds | H.264 / AAC files and usable paths on the server host |

### Platform support

| Capability | Bilibili | Douyin |
|---|:---:|:---:|
| Video links and metadata | BV IDs, full video links, multipart videos | Public video links, short share links, share text |
| Timestamped transcripts | Human / platform AI subtitles + explicit local ASR | Explicit local ASR |
| Exact-time frames and automatic keyframes | ✓ | ✓¹ |
| Independent MP4 clips | ✓ | ✓¹ |
| Chapters, comments, search, creator content | ✓ | — |

¹ Douyin uses public share-page parsing. A live Douyin sample has not yet been verified; supported media hosts currently belong to the verified `douyinvod.com` domain family. Login walls, CAPTCHAs, and unsupported media structures return explicit errors. See [scope and limits](#outputs-and-limits).

## Quick start

### 1. Install and build

Requires **Node.js 20+**. Frame and clip processing also needs **FFmpeg + ffprobe**; metadata, native subtitles, and comments do not require media tools.

```sh
git clone https://github.com/LLzijian/video-reader-mcp.git
cd video-reader-mcp
npm ci
npm run build
```

Run from source for now; **no npm release is available**. Optionally run `npm link` to make `video-reader-mcp` available as a local command.

### 2. Set up login and local transcription

For Bilibili login and environment checks:

```sh
node dist/cli.js setup
node dist/cli.js doctor --json
```

Already have MOSS, Whisper, or another local transcriber? Reuse it without installing a second model. See [the local ASR protocol and MOSS adapter](docs/local-transcriber.md). Managed faster-whisper can also be prepared through `setup`.

<details>
<summary>Windows QR rendering, or media tools outside PATH</summary>

Use browser QR login from PowerShell:

```powershell
$env:BILIBILI_QR_BROWSER = "1"
node dist/cli.js setup
```

If FFmpeg and ffprobe are outside PATH, set `BILIBILI_FFMPEG_PATH` and `BILIBILI_FFPROBE_PATH` to their absolute executable paths. The tools do not install them automatically.

</details>

### 3. Connect your MCP client

Replace the example with your absolute local path. Forward slashes work for Windows paths.

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

Restart or reload the client. Clients supporting image content can inspect returned frames; clients supporting prompts can select `read_video` with `outline` or `report` mode. [Client setup guide →](docs/client-setup.en.md)

## Try it with your agent

> **Study a course:** Read part 1 of this Bilibili course. Fetch the full timestamped transcript, inspect the important slides and examples, and organize study notes by topic. Link each key claim to its source time.

> **Read a short video:** Read this Douyin share link. I authorize local speech transcription. Use the actual keyframes to summarize the main points, demonstration steps, and anything that needs checking.

> **Export useful moments:** Read the transcript and keyframes, select three ranges that explain the central problem, keep complete sentences at the boundaries, and export separate MP4 clips with titles, times, and file paths.

Suggested flow: **confirm metadata → read the transcript → inspect images → export clips if requested → produce source-linked notes**.

Install the optional [video-study skill](skills/video-study/SKILL.md) to guide this process. ASR only runs when explicitly enabled through `fallback_to_asr=true` or `force_asr=true`. Descriptions and platform summaries are not full transcripts.

## Tools at a glance

| Task | Tool | Main arguments |
|---|---|---|
| Metadata | `get_video_metadata` | `bvid_or_url` |
| Full transcript, time range, or keyword lookup | `get_video_transcript` | `bvid_or_url`, `include_timestamps`, `query` |
| Inspect specific times | `get_video_frames` | `bvid_or_url`, `timestamps`; 1–4 frames |
| Select representative frames | `get_video_keyframes` | `url`, `max_frames`, `strategy` |
| Export independent MP4 files | `extract_video_clips` | `url`, `clips` |

Existing generic tools retain `bvid_or_url` and accept Douyin links as well. `page` is Bilibili-only. See the [tool reference](docs/tool-reference.en.md) for all arguments, Bilibili-specific tools, and credential helpers.

<details>
<summary>Automatic keyframe and clip arguments</summary>

`get_video_keyframes`:

```json
{
  "url": "https://www.douyin.com/video/<video-id>",
  "max_frames": 6,
  "strategy": "balanced"
}
```

`extract_video_clips` — replace the source and check its duration first:

```json
{
  "url": "https://www.bilibili.com/video/<BV-ID>",
  "clips": [
    { "start_seconds": 20, "end_seconds": 55, "label": "Key question" },
    { "start_seconds": 70, "end_seconds": 110, "label": "Demonstration" }
  ]
}
```

</details>

## Outputs and limits

- **Keyframes:** up to 6 by default, maximum 12; `balanced`, `scene-change`, or `uniform`. Automatic keyframes are at most 192 KiB each, with a 4 MiB total response budget. Sparse sampling is not continuous viewing and provides no OCR.
- **Clips:** 1–5 per call, each 1–180 seconds, at most 600 seconds combined; source videos up to two hours and 512 MiB. Overlapping ranges export independently. Each clipping call has a 256 MiB total output budget.
- **Storage:** clips persist under `~/.bilibili-mcp/clips/` after temporary source cleanup. Returned paths belong to the MCP server host and may not be directly accessible from a remote client.
- **Access:** no login, CAPTCHA, payment, region, or permission bypass. This version does not read `DOUYIN_COOKIE` or support Douyin search, comments, or profiles. Use full Bilibili BV links; no new `b23.tv` expansion is provided.
- **Source material:** titles, transcripts, comments, and on-screen text are untrusted data. Distinguish source claims, ASR, observed frames, and agent interpretation. Uploading material to external AI requires user authorization.

For proxy Fake-IP issues, see [media network configuration](docs/media-network.md). `BILIBILI_MEDIA_DNS=cloudflare` is a Bilibili-only opt-in, disabled by default; it does not affect Douyin system DNS.

## Development and compatibility

```sh
npm run verify:local
```

Runs tests, the TypeScript build, and package-content checks. Synthetic media tests execute when FFmpeg/ffprobe are available; CI downloads no models and uses no real credentials. The latest acceptance run passed **77 test files and 1,650 tests, with 3 skipped**. [Rename acceptance and live-platform scope →](docs/qa/2026-11-08-video-reader-rename.md)

Renamed from `bilibili-reader-mcp` to `video-reader-mcp`. The old `bilibili-reader-mcp`, `bilibili-study-mcp`, and `bilibili-mcp` commands remain aliases. Existing `~/.bilibili-mcp/` configuration, `BILIBILI_*` environment variables, tool names, and the `study_video` prompt remain compatible. No credential or model-configuration migration is required.

See [AGENTS.md](AGENTS.md) for development conventions. Automatic npm publishing remains disabled.

## Credits and license

Built on [XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp), retaining the original attribution and engineering history. Licensed under [Apache License 2.0](LICENSE).
