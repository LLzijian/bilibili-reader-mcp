# Client setup

Run from source; no npm release is available yet. Follow the [README](../README_EN.md) to install dependencies and build; use setup for Bilibili login. Douyin reads public pages without Bilibili login and does not read `DOUYIN_COOKIE`; login walls and CAPTCHAs fail explicitly.

Configure a stdio MCP client with Node.js and the absolute path to dist/index.js:

~~~json
{"mcpServers":{"video-reader":{"command":"node","args":["/absolute/path/to/video-reader-mcp/dist/index.js"]}}}
~~~

A client supporting MCP image content can inspect actual JPEG output from `get_video_frames` and `get_video_keyframes`. Clients supporting prompts can select multiplatform `read_video` (`url`, optional `mode=outline|report`) or the original Bilibili `study_video`. Text-only clients can read transcripts but cannot inspect frames.

Set `BILIBILI_TRANSCRIBER_CONFIG` in the service environment to an absolute local JSON configuration path to reuse an existing model; no duplicate managed-model installation is required. Use setup to prepare managed faster-whisper if selected. ASR calls still require explicit `fallback_to_asr=true` or `force_asr=true`; ASR never starts by default. See [local ASR configuration](local-transcriber.md).

Install FFmpeg and ffprobe yourself for media processing. They default to PATH; set `BILIBILI_FFMPEG_PATH` and `BILIBILI_FFPROBE_PATH` if they are outside PATH. The tools do not install them automatically. Restart the client after configuration changes.

`extract_video_clips` returns absolute paths on the server host; MP4 files persist in `~/.bilibili-mcp/clips/`, with no base64 video. A remote MCP path may not be directly accessible by the client. Users manage retained files. See [the tool reference](tool-reference.en.md) for parameters and platform limits.

Bilibili credentials remain in `~/.bilibili-mcp/`, outside client configuration and the repository. Use `node dist/cli.js doctor --json` for redacted local status and `node dist/cli.js check` for online Bilibili login verification. Set `BILIBILI_QR_BROWSER=1` before setup to open a browser QR page. Rebuild and restart the MCP client after source updates.

Optional Fake-IP compatibility: set `BILIBILI_MEDIA_DNS=cloudflare` for this MCP service only, with user consent. Default system DNS and all public-address checks remain. See [media network configuration](media-network.md).
