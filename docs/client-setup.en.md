# Client setup

Run this fork from source; no npm release is available yet. Follow the [README](../README_EN.md) to install dependencies, build and log in with setup.

Configure a stdio MCP client with Node.js and the absolute path to dist/index.js:

~~~json
{"mcpServers":{"bilibili-study":{"command":"node","args":["/absolute/path/to/bilibili-study-mcp/dist/index.js"]}}}
~~~

A client supporting MCP image content can inspect get_video_frames output. Clients supporting prompts can select study_video. Text-only clients can read transcripts but cannot inspect frames.

Set BILIBILI_TRANSCRIBER_CONFIG to an absolute local configuration path to reuse an existing model. Set BILIBILI_FFMPEG_PATH if FFmpeg is outside PATH. See [local ASR configuration](local-transcriber.md).

Credentials remain in ~/.bilibili-mcp/, outside client configuration and the repository. Use node dist/cli.js doctor --json for redacted local status and node dist/cli.js check for online login verification. Set BILIBILI_QR_BROWSER=1 before setup to open a browser QR page. Rebuild and restart the MCP client after source updates. Fake-IP troubleshooting is in the [tool reference](tool-reference.en.md).

Optional Fake-IP compatibility: set BILIBILI_MEDIA_DNS=cloudflare for this MCP service only, with user consent. Default system DNS and all public-address checks remain. See [media network configuration](media-network.md).
