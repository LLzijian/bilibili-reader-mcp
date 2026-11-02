# Bilibili Study MCP

Read Bilibili lectures, courses and tutorials with **full timestamped transcripts and selected original video frames**, then let your agent write a source-linked outline or study report.

An Apache-2.0 fork of [XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp), retaining the original attribution and license.

[中文](README.md) · [Tools](docs/tool-reference.en.md) · [Local ASR](docs/local-transcriber.md) · [Study skill](skills/bilibili-study/SKILL.md)

## Features

- Human subtitles, Bilibili AI subtitles, timestamp ranges, keyword lookup and multipart videos.
- get_video_frames returns actual JPEG image content to a vision-capable MCP client, with timestamps and source links, for slides, charts, formulas and demonstrations.
- Keep managed faster-whisper as an option, or reuse an installed local transcription program through a validated command configuration. An example adapter supports an existing moss-transcribe installation.
- Keep metadata, chapters, search, creator content and comments. Personal favorites are removed.
- study_video MCP prompt and optional agent skill guide outline/report generation. The host agent supplies reasoning and vision; the server requires no extra cloud model.

## Run from source

Requires Node.js 20+. Frame extraction also requires FFmpeg in PATH or BILIBILI_FFMPEG_PATH pointing to its executable.

~~~sh
git clone https://github.com/LLzijian/bilibili-study-mcp.git
cd bilibili-study-mcp
npm ci
npm run build
node dist/cli.js setup
node dist/cli.js doctor --json
~~~

There is no npm release yet. Optionally run npm link for a local bilibili-study-mcp command. Credentials stay in ~/.bilibili-mcp/, outside the repository. Set BILIBILI_QR_BROWSER=1 before setup to show the QR code in your default browser; the temporary page is deleted when the attempt ends.

MCP client configuration (replace the path with your absolute local path):

~~~json
{"mcpServers":{"bilibili-study":{"command":"node","args":["/absolute/path/to/bilibili-study-mcp/dist/index.js"]}}}
~~~

To reuse a local ASR program, configure ~/.bilibili-mcp/transcriber.json or BILIBILI_TRANSCRIBER_CONFIG. See [the protocol and adapter example](docs/local-transcriber.md). Restart the client after configuration changes.

## Study workflow

Ask your agent to read a course transcript, inspect key slides or demonstrations, and create an outline or report with timestamp links. Clients supporting MCP prompts can select study_video with bvid_or_url, optional page, and mode=outline or report. The optional skill is in skills/bilibili-study.

get_video_frames takes bvid_or_url, optional page, and timestamps (1–4 seconds values per call). The first call downloads an accessible AVC stream up to 1080p. One video is cached in process-owned temporary storage for 30 minutes. Limits: 512 MiB/video, two hours/part, 1280px output width and 512 KiB/JPEG. This is selected-frame reading, not continuous video analysis. Comments are optional supporting material, distinct from the lecturer's claims.

## Development

Run npm run verify:local for tests, build and package-content checks. CI uses no real credentials or model downloads. Real FFmpeg and model inference are checked separately. Current development rules are in AGENTS.md. Automatic npm publishing is disabled.

Optional Fake-IP compatibility: set BILIBILI_MEDIA_DNS=cloudflare for this MCP service only, with user consent. Default system DNS and all public-address checks remain. See [media network configuration](docs/media-network.md).
