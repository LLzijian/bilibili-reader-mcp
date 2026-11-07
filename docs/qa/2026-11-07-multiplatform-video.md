# 多平台视频阅读开发验收记录

## 结论

本地开发验收通过。`npm run verify:local`：77 个测试文件通过，1647 个测试通过、3 个按平台条件跳过；TypeScript 构建通过；包内容检查通过（298 个文件）。使用独立 FFmpeg/ffprobe 9.0.2 的合成媒体测试实际执行，并非全部 mock。

真实平台验证仅覆盖一个公开 Bilibili 样本：元数据读取成功，媒体获取因本机代理 Fake-IP DNS 被安全策略拒绝；未验证真实抖音样本，不宣称线上端到端全部可用。

开发分支：`feat/multiplatform-video-reading`。功能基线：`8d1296f`（已有 reader 命名、指定时间抽帧、本地转写）。公共契约基点：`ef202e1`，见 [接口契约](../tasks/2026-11-07-multiplatform-video-contracts.md)。本轮实现保留为工作区改动，未提交、推送、合并或发布。

尝试抓取最新 `origin/master` 时连接重置，因此以本地已验证功能分支开发；没有宣称与当前远端完全同步。

## 工具与兼容性

| 接口 | 参数与行为 |
| --- | --- |
| `get_video_keyframes` | `url`，可选 `max_frames=6`（1–12）与 `strategy=balanced/scene-change/uniform`；直接返回 JPEG 图片 content 和原视频秒数 |
| `extract_video_clips` | `url`、`clips=[{start_seconds,end_seconds,label?}]`；1–5 段，各 1–180 秒，总计最多 600 秒；重叠独立导出 |
| `get_video_metadata` | 原 `bvid_or_url` 保留，抖音走公开分享页解析，不下载完整媒体 |
| `get_video_transcript` | 原参数保留；抖音需要 `fallback_to_asr=true` 或 `force_asr=true` 明确允许本地 ASR，默认不会下载转写；支持原时间段和关键词检索语义 |
| `get_video_frames` | 原 `bvid_or_url` 与 1–4 个 `timestamps` 保留；抖音走统一媒体管线，拒绝 `page` |
| `read_video` prompt | `url`、可选 `mode=outline/report`；保留旧 `study_video` 参数与行为 |

原 12 个工具名称、排序和必填输入均保留，新工具追加为第 13、14 项。Bilibili 的分集、字幕选择、显式 ASR、Cookie/WBI 访问与 Fake-IP 诊断保持原入口；章节、评论、搜索、创作者及 `get_video_info` 仍是 Bilibili 专用。逐字稿输出 schema 保留 Bilibili `bvid` 分支，另允许抖音 `platform`/`video_id` 分支，不伪造 BV 号。

新增 `skills/video-study/SKILL.md`，保留旧 `skills/bilibili-study`。包名、CLI 名称及发布配置未改变。

## 实现与资源边界

- 平台层：统一 `VideoSource`，视频 ID 始终为字符串；抖音长链、短链、分享文本与有界嵌入 JSON 解析。HTML 最多 4 MiB，JSON 深度、节点、数组与字段长度均受限。所有远端文本经清理。
- 媒体层：progressive、分离轨下载与 mux、ffprobe、独立临时目录注册表和内部 lease。最多 2 个 acquisition/lease 槽位，在请求候选与下载前占用，持续至清理完成；失败、取消和重复 release 均有行为测试。
- 下载：源最多 512 MiB、时长最多 7200 秒；音频最多 128 MiB；总下载/获取期限 180 秒；跨失败候选共享字节预算，地址和重定向逐跳校验。任意有限正时长可用于抽帧，剪辑另要求至少一秒。
- ASR：新增仅内部使用的 `transcribeAudioFile`，共享原 readiness、runtime、并发锁与结果限制。只接受已登记临时目录中的真实文件。progressive 转写前先提取 16 kHz 单声道 AAC 音轨，避免完整视频尺寸误触音频上限。没有下载模型、切换模型或运行真实 ASR 模型测试。
- 关键帧：均匀候选保底、场景检测补充、局部感知去重、时间分区选择；候选最多 120。最终图片单张最多 192 KiB（原指定时间抽帧仍为 512 KiB），全 MCP 响应最多 4 MiB。稀疏采样无 OCR，无语义重要性保证。
- 剪辑：重编码 H.264/AAC、保留原音轨（若存在）、等比缩放且不放大，输出最大 1920×1080。每次任务总输出最多 256 MiB。先写独占 partial 文件，经 probe 核对 MP4、编码、音轨、大小与目标时长 ±0.25 秒后原子改名。失败回滚本次 partial 和最终文件，不删除源或用户已有文件。
- 输出：持久保存在应用用户目录的 `clips/job-*/<随机ID>.mp4`，不随源 lease 删除；远程 MCP 的文件路径指向服务器主机。目录拒绝 symlink/junction 与不安全路径；Windows 使用真实路径、access 与系统 ACL，POSIX 另检查写权限。
- 进程：本地文件协议白名单、参数数组、`shell:false`、受控环境、线程/字节/超时限制，取消时终止进程树。

## 抖音支持边界与凭据

仅公开页面；本版不读取或发送 `DOUYIN_COOKIE`，不提供抖音 Cookie 配置。登录墙、验证码、权限不足或不支持的页面/媒体结构返回明确错误，不绕过访问限制。

页面 host 精确限制为 `www.douyin.com`、`v.douyin.com`、`www.iesdouyin.com`；媒体只信任有公开依据的 `douyinvod.com` 域名族。没有猜测放宽 ByteDance CDN 域名。Bilibili 原 allowlist 未扩大；独立抖音 policy 保留公网 IP 检查、DNS 固定、重定向检查及凭据头剥离。

`BILIBILI_MEDIA_DNS` 只影响允许该选项的 Bilibili policy；抖音继续使用系统 DNS，不隐式调用公共 DoH。未启用需要用户选择的公共 DNS 回退。

Bilibili `b23.tv` 可以识别，但本轮未增加短链展开设施；无 BV 的短链需改用完整视频链接。抖音的规范来源链接不保证浏览器秒数跳转，结果另给明确时间。

## 测试证据

最终原命令 `npm run verify:local`（仅进程环境设置独立 FFmpeg/ffprobe 路径）：

```text
Test Files  77 passed (77)
Tests       1647 passed | 3 skipped (1650)
Duration    29.09s
TypeScript  build passed
Package     contents OK: 298 files
```

3 项跳过：两个既有 Windows CLI 条件项，以及 POSIX 目录模式权限专用断言。FFmpeg 合成媒体相关测试使用实际可执行工具，未因缺工具而整体跳过；不把工具临时绝对路径写入仓库或用户配置。

主要覆盖：

- 分享文本、64 位 ID、域名欺骗、userinfo、端口、逐跳 DNS/IP、重定向次数与取消。
- `_ROUTER_DATA`、`RENDER_DATA`、畸形/深层/超大页面、普通视频与图集/直播/删除/私密区分。
- progressive、split mux、单独音轨、无轨/损坏文件、下载中断/字节预算、凭据头拒绝与临时文件清理。
- 本地与 managed ASR 的依赖注入、readiness、非登记/符号链接路径拒绝、并发与取消；不调用真实模型。
- 合成静态与多场景视频的覆盖、去重、真实 JPEG 解码、低帧率尾部、单帧短视频、图片降级、总期限与真实进程取消。
- 有/无音轨 MP4，多片段、红蓝画面及 440/880 Hz 音频边界、源尾边界、奇数尺寸/竖屏、分辨率限制、输出可再次解码、partial 与多段失败回滚。
- MCP 注册、旧输入兼容、新字段运行时校验、显式 ASR 授权、图片 content、逐字稿查询与结构化错误不泄露原始消息。

新增 `vitest.config.ts` 将默认测试发现范围限定为 `tests/**/*.test.ts`，排除 `.claude/worktrees` 副本，避免并行 smoke test 重建同一 `dist`。早期全测确实因扫描 worktree 副本及旧工具列表快照失败；已修复后以原命令完整通过，未提高既有测试超时或跳过失败测试。

独立审查发现的媒体 lease 并发、平台 DNS 配置隔离及不足一秒视频问题均已补测试修复；复核确认三项关闭。另修复剪辑异常保留真实 `FfmpegUnavailableError`，使用真实错误类测试，而非虚构的 `.code` 字段替身。

文档本地链接检查与 `git diff --check` 通过。所有媒体 fixture 为运行时合成，抖音页面 fixture 为合成数据；没有提交真实 Cookie、临时签名媒体地址或私人材料。

## 真实平台 smoke

| 平台/样本 | 元数据 | 媒体/关键帧 | ASR/片段 |
| --- | --- | --- | --- |
| Bilibili `BV1GJ411x7h7`，公开样本 | 成功，返回标题/作者/时长/分集等结构 | 下载前检测到代理 Fake-IP，返回 `MEDIA_FAKE_IP_DNS`，未进行外部 DNS 回退 | 未执行 |
| 抖音 | 未执行：没有可确认的公开测试样本 | 未执行 | 未执行 |

本地 ASR 与真实抖音端到端仍需单独验证。下一步使用用户有权访问的公开抖音链接，并在用户选择的网络 DNS 配置下检查解析、下载、ASR、关键帧和 MP4；不得将合成测试通过等同于线上成功率。

## 文件范围

实现与文档文件列表见下列清单；共享类型和错误类在此前契约提交中已建立。

- `README.md`
- `README_EN.md`
- `docs/client-setup.en.md`
- `docs/client-setup.md`
- `docs/qa/2026-11-07-multiplatform-video.md`
- `docs/tool-reference.en.md`
- `docs/tool-reference.md`
- `skills/video-study/SKILL.md`
- `src/asr/transcription.ts`
- `src/bilibili/subtitle.ts`
- `src/douyin/adapter.ts`
- `src/douyin/http.ts`
- `src/douyin/metadata.ts`
- `src/douyin/playback.ts`
- `src/douyin/url.ts`
- `src/media/acquire.ts`
- `src/media/bilibili-source.ts`
- `src/media/clips.ts`
- `src/media/default-sources.ts`
- `src/media/downloader.ts`
- `src/media/ffmpeg.ts`
- `src/media/keyframes.ts`
- `src/media/temp.ts`
- `src/platforms/bilibili-adapter.ts`
- `src/platforms/registry.ts`
- `src/platforms/url.ts`
- `src/security/pinned-https.ts`
- `src/server.ts`
- `src/server/error-response.ts`
- `src/server/read-video-prompt.ts`
- `src/server/tool-handlers.ts`
- `src/server/tool-schemas.ts`
- `src/server/video-services.ts`
- `src/server/video-transcript.ts`
- `src/utils/error-guidance.ts`
- `tests/asr-media-input.test.ts`
- `tests/douyin-adapter.test.ts`
- `tests/douyin-http.test.ts`
- `tests/douyin-metadata.test.ts`
- `tests/douyin-playback.test.ts`
- `tests/douyin-url.test.ts`
- `tests/fixtures/douyin.ts`
- `tests/mcp-server-smoke.test.ts`
- `tests/media-acquire.test.ts`
- `tests/media-bilibili-source.test.ts`
- `tests/media-downloader.test.ts`
- `tests/media-ffmpeg.test.ts`
- `tests/media-integration.test.ts`
- `tests/media-temp.test.ts`
- `tests/server-tools.test.ts`
- `tests/video-clips.test.ts`
- `tests/video-error-guidance.test.ts`
- `tests/video-keyframes.test.ts`
- `tests/video-platform-url.test.ts`
- `tests/video-study-prompt.test.ts`
- `tests/video-tools.test.ts`
- `tests/video-transcript-format.test.ts`
- `vitest.config.ts`
