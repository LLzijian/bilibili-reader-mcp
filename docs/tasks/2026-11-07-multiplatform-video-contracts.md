# 多平台视频阅读：冻结接口契约(2026-11-07)

本文档是 01(平台层)、02(媒体管线)、03(关键帧)、04(剪辑)、05(MCP 集成)之间的**唯一契约来源**。类型定义以代码为准:`src/platforms/types.ts`、`src/media/types.ts`、`src/utils/errors.ts` 中 2026-11-07 冻结的错误类。函数签名以本文为准，实现必须与本文逐字一致(参数名可不同，类型与模块路径必须一致)。

## 1. 模块归属(不得越界写文件)

| Agent | 拥有文件 | 禁止修改 |
|---|---|---|
| 01 平台层 | `src/platforms/url.ts`、`src/platforms/registry.ts`、`src/platforms/bilibili-adapter.ts`、`src/douyin/**`、`src/security/pinned-https.ts`(仅按 §4 扩展)、对应测试 | `src/media/**`、`src/asr/**`、`src/server/**`、`src/utils/errors.ts` |
| 02 媒体管线 | `src/media/**`(不含 keyframes.ts / clips.ts)、`src/asr/transcription.ts`(仅按 §6 扩展)、对应测试 | `src/platforms/**`、`src/douyin/**`、`src/server/**`、`src/utils/errors.ts`、`src/security/pinned-https.ts` |
| 03 关键帧 | `src/media/keyframes.ts`、对应测试 | 其他 |
| 04 剪辑 | `src/media/clips.ts`、对应测试 | 其他 |
| 05 MCP 集成 | `src/server/**`、`skills/**`、`docs/**`、README、`src/media/default-sources.ts` 的抖音注册行 | 平台/媒体内部实现 |

主 Agent 拥有:`src/platforms/types.ts`、`src/media/types.ts`、`src/utils/errors.ts`、`src/media/default-sources.ts` 的最终接线。

## 2. 已冻结的共享类型(代码)

见 `src/platforms/types.ts`:`VideoPlatform`、`VideoSource`、`MediaStreamCandidate`、`MediaCandidateSet`、`VideoPlatformAdapter`。
见 `src/media/types.ts`:`PlatformMediaSource`、`MediaPurpose`、`MediaAcquireOptions`、`MediaAsset`。
错误:`PlatformError`、`MediaError`、`KeyframeError`、`ClipError`、`FfmpegUnavailableError`(及各自 code 字面量),已加入 `src/utils/errors.ts`。

要点回顾:`VideoSource.videoId` 永远是 string;`MediaCandidateSet` 必须恰好有 `progressive` 或 `split` 之一且非空;`requestHeaders` 不得含 Cookie/Authorization/Proxy-Authorization(媒体层必须校验并拒绝);`MediaAsset` 至少含 `videoPath`/`audioPath` 之一。

## 3. 平台层冻结签名(01 实现)

```ts
// src/platforms/url.ts
export function extractUrlsFromText(text: string): string[];          // 有界:输入 ≤ 64KiB,输出 ≤ 16 条
export function normalizePlatformUrl(raw: string): URL | undefined;   // https、无 userinfo、默认端口

// src/platforms/registry.ts
export function listPlatformAdapters(): readonly VideoPlatformAdapter[];
export function findAdapterForUrl(input: URL): VideoPlatformAdapter | undefined;
export function detectPlatform(input: string): VideoPlatform | undefined; // 纯函数,不发网络请求
export function getAdapter(platform: VideoPlatform): VideoPlatformAdapter;
export function resolveVideoSource(input: string, signal?: AbortSignal): Promise<VideoSource>;

// src/platforms/bilibili-adapter.ts
export const bilibiliAdapter: VideoPlatformAdapter;  // canHandle + resolve;resolve 包装现有 extractBVId + getVideoMetadataData

// src/douyin/adapter.ts
export const douyinAdapter: VideoPlatformAdapter & PlatformMediaSource;
```

`resolveVideoSource(input)`:从分享文本抽 URL(或直接解析 URL)→ `findAdapterForUrl` → adapter.resolve。无匹配时抛 `PlatformError("UNSUPPORTED_PLATFORM", …)`。

`douyin/playback.ts` 内部函数命名自定,但最终经 `douyinAdapter.getMediaCandidates(source, signal)` 暴露。抖音页面 fetch、短链展开、CDN 校验全部在 01 内部完成,媒体层不感知。

## 4. pinned-https 扩展(01 实现,02 不动此文件)

保留现有 `pinnedHttpsFetch` 导出与 Bilibili allowlist 行为不变。新增工厂:

```ts
// src/security/pinned-https.ts(追加)
export interface PinnedHttpsPolicy {
  allowedHostSuffixes: readonly string[];   // 如 [".douyin.com"] 的规范化后缀,必须带前导点
  allowPublicDnsFallback?: boolean;          // 默认 false;为 true 时 queryPublicMediaDns 需支持对应域名
}
export function createPinnedHttpsFetch(
  policy: PinnedHttpsPolicy,
): (input: string | URL | Request, init?: RequestInit, options?: PinnedHttpsFetchOptions) => Promise<Response>;
```

`createPinnedHttpsFetch` 与现有实现共享 DNS 固定、非公网 IP 拒绝、Cookie/Authorization 剥离、仅 GET、Fake-IP 检测逻辑。现有 `pinnedHttpsFetch` 重构为该工厂的 Bilibili 实例,行为不变,`tests/pinned-https.test.ts` 必须全部通过。抖音 policy 的 allowlist 只能包含真实验证过的抖音页面/CDN 域名,fixture 脱敏。

## 5. 媒体管线冻结签名(02 实现)

```ts
// src/media/temp.ts
export function createMediaTempDir(): Promise<string>;   // 前缀 "bilibili-reader-media-",登记入内部注册表
export function cleanupMediaTempDir(dir: string): Promise<void>;
export function isRegisteredTempDir(path: string): boolean; // 同时认可 media 与 ASR 前缀目录

// src/media/ffmpeg.ts
export function resolveFfmpegPath(): string;    // env BILIBILI_FFMPEG_PATH ?? "ffmpeg"
export function resolveFfprobePath(): string;   // env BILIBILI_FFPROBE_PATH ?? "ffprobe"
export interface FfmpegRunOptions { timeoutMs?: number; maxStderrBytes?: number; signal?: AbortSignal; }
export function runFfmpeg(args: readonly string[], options?: FfmpegRunOptions): Promise<{ stderr: string }>;
export interface ProbeStream { type: "video" | "audio" | "other"; codecName?: string; width?: number; height?: number; }
export interface ProbeResult { durationSeconds: number; sizeBytes: number; streams: ProbeStream[]; formatName?: string; }
export function probeMediaFile(filePath: string, signal?: AbortSignal): Promise<ProbeResult>;
```

`runFfmpeg`:`spawn` 且 `shell: false`,受控 env(复用 ASR 的 `buildAsrRuntimeEnv` 模式,可在 media 层建等价函数),超时 kill 进程树(Windows taskkill 模式可复用),stderr 截断,取消即杀。FFmpeg 不得访问网络:参数必须含 `-protocol_whitelist file,pipe`(输入为本地文件时)。`probeMediaFile` 解析 ffprobe JSON 时必须逐字段类型校验,不信任媒体内 metadata。

```ts
// src/media/acquire.ts
export function registerMediaSource(source: PlatformMediaSource): void;   // 重复注册同 platform 抛错
export function getRegisteredMediaSource(platform: VideoPlatform): PlatformMediaSource | undefined;
export function acquireVideoMedia(
  source: VideoSource,
  options: MediaAcquireOptions,
  signal?: AbortSignal,
): Promise<MediaAsset>;
export function releaseMediaAsset(asset: MediaAsset): Promise<void>;      // 幂等;释放其内部 lease
export function withMediaAsset<T>(
  source: VideoSource,
  options: MediaAcquireOptions,
  fn: (asset: MediaAsset) => Promise<T>,
  signal?: AbortSignal,
): Promise<T>;
```

`acquireVideoMedia` 行为:查 media source → 取候选并再校验 → 下载到 `createMediaTempDir()`(progressive 单文件;split 分别下载视频轨与可选音频轨)→ 必要时 FFmpeg mux 为单个 `video.mp4`(输出 `.partial` 后缀,验证后原子改名)→ `probeMediaFile` 校验时长/流/大小 → 组装 MediaAsset 并登记 lease。下载执行器按 `source.platform` 选择:bilibili → 复用 `downloadPlaybackAudio` 同款 pinnedHttpsFetch;抖音 → 由 media source 自带的 fetch(见 §7)。`purpose === "transcript"` 且候选为 split 时允许只下载音频轨到 `audio.m4a`(此时 MediaAsset 无 videoPath)。上限:时长 ≤ 7200s,视频 ≤ 512MiB,音频 ≤ 128MiB,下载总超时 ≤ 180s,候选尝试 ≤ 3。所有失败/取消路径清理临时目录并撤销 lease。

```ts
// src/media/bilibili-source.ts(02 实现,薄包装现有 playback/frames 解析)
export function createBilibiliMediaSource(deps?: { /* 测试注入 */ }): PlatformMediaSource;
```

```ts
// src/media/default-sources.ts(02 创建,只注册 bilibili;主 Agent 集成时加 douyin 行)
export function ensureDefaultMediaSources(): void;  // 幂等;注册 bilibili(及集成后 douyin)media source
```

## 6. ASR 解耦冻结签名(02 实现)

`src/asr/transcription.ts` 追加,现有导出与 `transcribeVideoPart` 行为不变:

```ts
export interface LocalAudioTranscriptionRequest {
  audioPath: string;         // 必须位于 isRegisteredTempDir() 认可的已登记临时目录内
  durationSeconds: number;   // ≤ MAX_ASR_DURATION_SECONDS
}
export function transcribeAudioFile(
  request: LocalAudioTranscriptionRequest,
  dependencies?: AsrTranscriptionDependencies,   // 可收窄复用;不得新增网络类依赖
  callerSignal?: AbortSignal,
):Promise<AsrTranscriptionResult>;
```

`transcribeAudioFile` 复用现有 readiness 检查、local-transcriber、managed runtime、并发锁(`ASR_BUSY`)、取消与输出限制;校验 `audioPath` 在已登记临时目录内(resolve 后判断,拒绝符号链接逃逸)。`transcribeVideoPart` 保持公开行为不变,内部可委托公共执行段,但不得改变 Bilibili 音频下载路径与错误语义。

## 7. 跨模块接线规则(关键)

- 02 **不得** import `../douyin/**` 或 `../platforms/registry.js`;抖音 media source 由主 Agent 在集成时于 `default-sources.ts` 注册。02 的单测一律 mock `PlatformMediaSource`。
- 01 **不得** import `../media/**`;`douyinAdapter` 只需 structurally 满足 `PlatformMediaSource`(自带 getMediaCandidates)。抖音下载所需的 pinned fetch:01 在 `src/douyin/` 内用 `createPinnedHttpsFetch`(§4)自建并随候选经约定通道传递——具体方式:`MediaCandidateSet` 不含 fetch;媒体层对 douyin 的下载改用 **01 在 `src/douyin/http.ts` 额外导出**的:
  ```ts
  // src/douyin/http.ts(01 实现)
  export function douyinMediaFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  ```
  02 对 douyin 平台通过统一注入点获得该 fetch:主 Agent 集成时在 `default-sources.ts` 注册
  `registerMediaSource(douyinAdapter)` 并 `setPlatformMediaFetch("douyin", douyinMediaFetch)`。
  ```ts
  // src/media/acquire.ts(02 实现,追加)
  export function setPlatformMediaFetch(platform: VideoPlatform, fetchFn: PlatformMediaFetch): void;
  export type PlatformMediaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  ```
  未注册 fetch 的平台:bilibili 默认 `pinnedHttpsFetch`;其他平台抛 `MediaError("MEDIA_DOWNLOAD_FAILED")`。
- 03/04 只 import `src/media/types.js`、`acquire.js`(或仅接收 MediaAsset)、`ffmpeg.js`、`temp.js`、`src/utils/errors.js`、`src/security/operation-context.js`、`src/security/limits.js`。不得 import 平台与 ASR 模块(03 如需时长直接用 asset.durationSeconds)。
- 05 集成时在 server 启动路径 import `../media/default-sources.js` 的 `ensureDefaultMediaSources()`。

## 8. 关键帧(03,契约)

```ts
// src/media/keyframes.ts
export interface Keyframe { timestampSeconds: number; image: Buffer; score?: number; reason?: string; }
export interface KeyframeOptions { maxFrames: number; strategy?: "balanced" | "scene-change" | "uniform"; }
export const KEYFRAME_LIMITS: { readonly minFrames: 1; readonly maxFrames: 12; readonly defaultFrames: 6; readonly maxCandidates: 120; readonly maxDurationSeconds: 7200 };
export function validateKeyframeOptions(raw: unknown): KeyframeOptions;  // 校验并填默认
export function extractKeyframes(asset: MediaAsset, options: KeyframeOptions, signal?: AbortSignal): Promise<Keyframe[]>;
```

算法按 03 计划文件 §4(均匀采样保底 + 场景检测增益 + 感知去重 + 时间线均衡)。单帧 ≤ `MAX_FRAME_BYTES`(从 `../bilibili/frames.js` 复用导出),抽帧宽度 ≤ 1280,候选 ≤ 120,输出按时间升序。asset 无视频轨抛 `KeyframeError("KEYFRAME_NO_VIDEO")`。

## 9. 剪辑(04,契约)

```ts
// src/media/clips.ts
export interface ClipRange { startSeconds: number; endSeconds: number; label?: string; }
export interface ClipResult {
  clipId: string; label?: string; startSeconds: number; endSeconds: number;
  durationSeconds: number; filePath: string; hasAudio: boolean;
  contentType: "video/mp4"; sizeBytes: number;
}
export const CLIP_LIMITS: {
  readonly minClipSeconds: 1; readonly maxClipSeconds: 180; readonly maxClips: 5;
  readonly maxTotalClipSeconds: 600; readonly maxSourceDurationSeconds: 7200;
};
export function validateClipRanges(raw: unknown, sourceDurationSeconds: number): ClipRange[];
export function extractVideoClips(asset: MediaAsset, clips: readonly ClipRange[], signal?: AbortSignal): Promise<ClipResult[]>;
export function resolveClipsDirectory(): string;   // GLOBAL_CONFIG_DIR/clips,创建并验证
```

输出:`~/.bilibili-mcp/clips/<随机ID>.mp4`(先 `.partial`,ffprobe 验证后原子改名)。重编码 libx264 veryfast crf 20 + AAC 128k + faststart;`-map 0:a:0?` 容忍无音轨;无视频轨抛 `ClipError`→ 实际用 `MediaError("MEDIA_NO_VIDEO_TRACK")` 亦可,任选并写测试。label ≤ 80 字符、清理路径分隔符;重叠区间不合并,按独立片段输出。片段文件**不**随 lease 清理(用户要保留),lease 只管理源媒体。

## 10. MCP 工具冻结签名(05 实现,03/04 完成后启动)

```
get_video_keyframes(url: string, max_frames?: 1..12=6, strategy?: "balanced"|"scene-change"|"uniform")
extract_video_clips(url: string, clips: [{start_seconds, end_seconds, label?}], 1..5 段)
```

现有 `get_video_metadata` / `get_video_transcript` / `get_video_frames` 扩展接受抖音 URL,参数名 `bvid_or_url` 保留,描述更新;Bilibili 语义(page、字幕、ASR fallback)不变。新增跨平台 prompt `read_video(url, mode)`;`study_video` 原样保留。

## 11. 全局规则(所有 Agent)

- 不往仓库提交真实 Cookie、签名 URL、真实视频、个人路径;fixture 脱敏合成。
- 远端文本(标题/作者/描述)经 `sanitizeRemoteText` 与长度上限。
- 取消信号贯穿:URL 解析 → 下载 → mux/probe → ASR → ffmpeg。
- 日志与错误不含 Cookie、签名参数、完整临时 URL(用 host 级别描述)。
- 每个非平凡模块配测试;`npm test` 在各自 worktree 全绿后汇报。
- 汇报格式:修改文件列表 / 公开接口 / 测试命令与结果 / 未完成项 / 影响其他 Agent 的变更。
