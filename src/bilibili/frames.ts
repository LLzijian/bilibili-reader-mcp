import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { credentialManager } from "../utils/credentials.js";
import { extractBVId } from "../utils/bvid.js";
import { AsrError, BilibiliAPIError, ResourceLimitError, ValidationError } from "../utils/errors.js";
import { getOperationSignal, throwIfAborted, createAbortError } from "../security/operation-context.js";
import { pinnedHttpsFetch } from "../security/pinned-https.js";
import { SECURITY_LIMITS } from "../security/limits.js";
import { ASR_TEMP_PREFIX, createAsrTempDir, cleanupAsrTempDir, downloadPlaybackAudio, buildAsrRuntimeEnv } from "../asr/transcription.js";
import { resolvePartCid, matchPartIdentity } from "./navigation.js";
import { validatePlaybackMediaUrl, type PlaybackAudioCandidate } from "./playback.js";
import { fetchWithoutWBI } from "./http.js";

export const MAX_FRAME_BYTES = 512 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const cache = new Map<string, { directory: string; file: string; expires: number }>();
let busy = false;

export function validateFrameTimestamps(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
    !value.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0 && time < 7200)) {
    throw new ValidationError("timestamps must contain 1–4 finite seconds in [0, 7200)");
  }
}

export function parseVideoCandidates(raw: unknown): PlaybackAudioCandidate[] {
  const videos = (raw as { dash?: { video?: unknown } } | null)?.dash?.video;
  if (!Array.isArray(videos) || videos.length > 256) throw new BilibiliAPIError("视频流信息不可用", "VIDEO_UNAVAILABLE");
  const supported = videos.filter((v) => v && typeof v === "object" &&
    (v.mimeType ?? v.mime_type) === "video/mp4" && typeof v.codecs === "string" && v.codecs.startsWith("avc1") &&
    Number.isFinite(v.height) && v.height > 0 && v.height <= 1080 &&
    Number.isFinite(v.bandwidth) && v.bandwidth > 0)
    .sort((a, b) => b.height - a.height || a.bandwidth - b.bandwidth);
  const selected = supported[0];
  if (!selected) throw new BilibiliAPIError("没有可读取的 1080p 或以下 AVC 视频流", "VIDEO_UNAVAILABLE");
  const backups = selected.backupUrl ?? selected.backup_url;
  const candidates: PlaybackAudioCandidate[] = [];
  for (const value of [selected.baseUrl ?? selected.base_url, ...(Array.isArray(backups) ? backups.slice(0, 2) : [])]) {
    try {
      candidates.push({ url: validatePlaybackMediaUrl(value), mimeType: "video/mp4", bandwidth: selected.bandwidth, representationId: selected.id });
    } catch { /* 上游返回的不安全备用地址不可使用。 */ }
  }
  if (!candidates.length) throw new BilibiliAPIError("没有安全的视频流地址", "VIDEO_UNAVAILABLE");
  return candidates;
}

// FFmpeg 只接收已校验并下载的本地文件，不能自行访问网络。
export function extractVideoFrame(file: string, seconds: number, signal?: AbortSignal): Promise<Buffer> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.BILIBILI_FFMPEG_PATH ?? "ffmpeg", [
      "-nostdin", "-v", "error", "-ss", String(seconds), "-protocol_whitelist", "file,pipe", "-i", file,
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: buildAsrRuntimeEnv(process.env) });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const onAbort = () => stop(createAbortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(new BilibiliAPIError("画面提取超时", "VIDEO_FRAME_TIMEOUT")), 30_000);
    const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) stop(new ResourceLimitError("画面大小超限", "frame_bytes", MAX_FRAME_BYTES));
      else chunks.push(chunk);
    });
    child.once("error", () => { clear(); reject(new BilibiliAPIError("无法启动 FFmpeg，请安装并设置 BILIBILI_FFMPEG_PATH", "FFMPEG_UNAVAILABLE")); });
    child.once("close", (code) => {
      clear();
      if (failure) return reject(failure);
      const data = Buffer.concat(chunks);
      if (code !== 0 || data.length < 4 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) {
        return reject(new BilibiliAPIError("该时间点没有可用画面", "VIDEO_FRAME_UNAVAILABLE"));
      }
      resolve(data);
    });
    if (signal?.aborted) onAbort();
  });
}

export async function clearVideoCache(): Promise<void> {
  for (const entry of cache.values()) await cleanupAsrTempDir(entry.directory);
  cache.clear();
}

// 进程退出时只清理由本进程创建、登记的缓存；正常使用最多保留一部视频。
process.once("exit", () => {
  for (const entry of cache.values()) {
    try { fs.rmSync(entry.file, { force: true }); fs.rmdirSync(entry.directory); } catch { /* 下次系统临时目录清理。 */ }
  }
});

export async function getVideoFrames(bvidOrUrl: string, timestamps: number[], page?: number, callerSignal?: AbortSignal) {
  validateFrameTimestamps(timestamps);
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  if (busy) throw new BilibiliAPIError("另一项画面读取正在进行，请稍后重试", "VIDEO_BUSY");
  busy = true;
  let pendingDirectory: string | undefined;
  try {
    const bvid = extractBVId(bvidOrUrl);
    const { cid, pages, videoData } = await resolvePartCid(bvid, page);
    throwIfAborted(signal);
    const identity = matchPartIdentity(cid, pages, videoData.title);
    const duration = pages.find((p) => p.cid === cid)?.duration ?? videoData.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 7200 || timestamps.some((t) => t >= duration)) {
      throw new ValidationError("时间点必须位于所选分集时长以内，当前支持最长 2 小时的视频");
    }
    const key = bvid + ":" + cid;
    let entry = cache.get(key);
    if (!entry || entry.expires < Date.now()) {
      await clearVideoCache();
      const raw = await fetchWithoutWBI("/x/player/playurl", { bvid, cid, fnval: 16, fnver: 0, qn: 80 }, {
        ...credentialManager.getAuthHeaders(), "User-Agent": config.userAgent, Referer: config.referer,
      }, signal, SECURITY_LIMITS.playbackJsonBytes);
      const candidates = parseVideoCandidates(raw);
      pendingDirectory = await createAsrTempDir(ASR_TEMP_PREFIX);
      const file = path.join(pendingDirectory, "video.mp4");
      await downloadPlaybackAudio(candidates, file, pinnedHttpsFetch, 180_000, signal, MAX_VIDEO_BYTES, "video");
      entry = { directory: pendingDirectory, file, expires: Date.now() + 30 * 60_000 };
      cache.set(key, entry);
      pendingDirectory = undefined;
    }
    const content: Array<TextContent | ImageContent> = [];
    for (const time of timestamps) {
      throwIfAborted(signal);
      const data = await extractVideoFrame(entry.file, time, signal);
      content.push({ type: "text", text: JSON.stringify({ bvid, page: identity.page, title: identity.title, timestamp_seconds: time,
        source_url: "https://www.bilibili.com/video/" + bvid + "/?p=" + identity.page + "&t=" + time }) });
      content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
    }
    if (Buffer.byteLength(JSON.stringify(content)) > SECURITY_LIMITS.mcpResponseBytes - 1024) {
      throw new ResourceLimitError("画面返回大小超限", "mcp_response_bytes", SECURITY_LIMITS.mcpResponseBytes);
    }
    return { content };
  } catch (error) {
    if (error instanceof AsrError && error.code !== "ASR_FAKE_IP_DNS") {
      if (error.code === "ASR_LIMIT_EXCEEDED") throw new ResourceLimitError("视频下载大小超过限制", "video_bytes", MAX_VIDEO_BYTES);
      throw new BilibiliAPIError("视频下载失败，请检查网络与视频访问权限", "VIDEO_DOWNLOAD_FAILED");
    }
    throw error;
  } finally {
    try { if (pendingDirectory) await cleanupAsrTempDir(pendingDirectory); }
    finally { busy = false; }
  }
}
