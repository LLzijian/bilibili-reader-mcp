import fs from "node:fs/promises";
import path from "node:path";
import type { MediaCandidateSet, MediaStreamCandidate, VideoPlatform, VideoSource } from "../platforms/types.js";
import { validatePlaybackMediaUrl } from "../bilibili/playback.js";
import { createAbortError, getOperationSignal, linkAbortSignal, throwIfAborted } from "../security/operation-context.js";
import { FakeIpDnsError, pinnedHttpsFetch } from "../security/pinned-https.js";
import { FfmpegUnavailableError, MediaError } from "../utils/errors.js";
import { downloadMediaFile, validateMediaHeaders, validateMediaUrl, type PlatformMediaFetch } from "./downloader.js";
import { probeMediaFile, runFfmpeg, type ProbeResult } from "./ffmpeg.js";
import { cleanupMediaTempDir, createMediaTempDir } from "./temp.js";
import type { MediaAcquireOptions, MediaAsset, PlatformMediaSource } from "./types.js";
export type { PlatformMediaFetch } from "./downloader.js";
const VIDEO_BYTES = 512 * 1024 * 1024;
const AUDIO_BYTES = 128 * 1024 * 1024;
const sources = new Map<VideoPlatform, PlatformMediaSource>();
const fetchers = new Map<VideoPlatform, PlatformMediaFetch>();
const MAX_MEDIA_LEASES = 2;
let activeMediaLeases = 0;
const leases = new WeakMap<MediaAsset, { dir: string; releaseSlot: () => void; releasing?: Promise<void> }>();
export function registerMediaSource(source: PlatformMediaSource): void {
  if (sources.has(source.platform)) throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "Media source already registered.");
  sources.set(source.platform, source);
}
export function getRegisteredMediaSource(platform: VideoPlatform): PlatformMediaSource | undefined { return sources.get(platform); }
export function setPlatformMediaFetch(platform: VideoPlatform, fetchFn: PlatformMediaFetch): void { fetchers.set(platform, fetchFn); }
function validateSet(set: MediaCandidateSet, platform: VideoPlatform): void {
  if (!set || (!!set.progressive === !!set.split)) throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "Invalid media candidate set.");
  validateMediaHeaders(set.requestHeaders);
  const lists = set.progressive ? [set.progressive] : [set.split!.video, ...(set.split!.audio ? [set.split!.audio] : [])];
  for (const list of lists) {
    if (!Array.isArray(list) || !list.length || list.length > 256) throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "Invalid media candidate list.");
    for (const candidate of list) {
      if (!candidate || typeof candidate.mimeType !== "string" || !["video/mp4", "audio/mp4", "audio/m4a"].includes(candidate.mimeType)) throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "Unsupported media candidate.");
      validateMediaUrl(candidate.url);
      if (platform === "bilibili") {
        try { validatePlaybackMediaUrl(candidate.url); } catch { throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Unsupported media location."); }
      }
    }
  }
}
function validateProbe(probe: ProbeResult, audioOnly: boolean, maxBytes: number, minDurationSeconds = 0): void {
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0 || probe.durationSeconds < minDurationSeconds || probe.durationSeconds > 7200 ||
    !Number.isSafeInteger(probe.sizeBytes) || probe.sizeBytes <= 0 || probe.sizeBytes > Math.min(maxBytes, audioOnly ? AUDIO_BYTES : VIDEO_BYTES)) {
    throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media duration or size exceeded its limit.");
  }
  if (!probe.streams.some((s) => s.type === (audioOnly ? "audio" : "video"))) {
    throw new MediaError(audioOnly ? "MEDIA_NO_AUDIO_TRACK" : "MEDIA_NO_VIDEO_TRACK", "Media is missing the required track.");
  }
}
export async function acquireVideoMedia(source: VideoSource, options: MediaAcquireOptions, callerSignal?: AbortSignal): Promise<MediaAsset> {
  const signal = getOperationSignal(callerSignal);
  throwIfAborted(signal);
  if (activeMediaLeases >= MAX_MEDIA_LEASES) {
    throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media acquisition lease limit reached.", true);
  }
  activeMediaLeases++;
  let holdsSlot = true;
  const releaseSlot = () => {
    if (!holdsSlot) return;
    holdsSlot = false;
    activeMediaLeases--;
  };
  try {
    return await acquireWithSlot(source, options, releaseSlot, signal);
  } catch (error) {
    releaseSlot();
    throw error;
  }
}
async function acquireWithSlot(source: VideoSource, options: MediaAcquireOptions, releaseSlot: () => void, signal?: AbortSignal): Promise<MediaAsset> {
  if (!["transcript", "frames", "keyframes", "clips"].includes(options.purpose) ||
    (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0))) throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Invalid media acquisition options.");
  const provider = sources.get(source.platform);
  if (!provider) throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "No media source registered for this platform.");
  const fetchFn = fetchers.get(source.platform) ?? (source.platform === "bilibili" ? pinnedHttpsFetch : undefined);
  if (!fetchFn) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "No media fetch registered for this platform.");
  const set = await provider.getMediaCandidates(source, signal);
  throwIfAborted(signal);
  validateSet(set, source.platform);
  const maxBytes = Math.min(options.maxBytes ?? VIDEO_BYTES, VIDEO_BYTES);
  const audioOnly = options.purpose === "transcript" && !!set.split?.audio?.length;
  const budget = { remainingBytes: Math.min(maxBytes, audioOnly ? AUDIO_BYTES : VIDEO_BYTES) };
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
  const dir = await createMediaTempDir().catch((error) => { clearTimeout(timer); unlink(); throw error; });
  let acquired = false;
  try {
    const count = Math.min(3, audioOnly ? set.split!.audio!.length : set.progressive?.length ?? Math.max(set.split!.video.length, set.split!.audio?.length ?? 0));
    let lastError: unknown;
    let fakeIpFailures = 0;
    for (let attempt = 0; attempt < count; attempt++) {
      throwIfAborted(controller.signal);
      const download = async (candidate: MediaStreamCandidate, name: string, limit: number) => {
        const file = path.join(dir, name);
        await downloadMediaFile(candidate.url, file, { fetchFn, maxBytes: Math.min(limit, maxBytes), budget,
          headers: set.requestHeaders, signal: controller.signal,
          validateUrl: source.platform === "bilibili" ? validatePlaybackMediaUrl : undefined });
        return file;
      };
      try {
        let file: string;
        if (audioOnly) file = await download(set.split!.audio![attempt], "audio.m4a", AUDIO_BYTES);
        else if (set.progressive) file = await download(set.progressive[attempt], "video.mp4", VIDEO_BYTES);
        else {
          const video = await download(set.split!.video[Math.min(attempt, set.split!.video.length - 1)], "video-track.mp4", VIDEO_BYTES);
          const audioCandidates = set.split!.audio;
          if (audioCandidates?.length) {
            const audio = await download(audioCandidates[Math.min(attempt, audioCandidates.length - 1)], "audio.m4a", AUDIO_BYTES);
            validateProbe(await probeMediaFile(audio, controller.signal), true, maxBytes);
            const partial = path.join(dir, "video.mp4.partial");
            try {
              await runFfmpeg(["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", video,
                "-protocol_whitelist", "file,pipe", "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "mp4", partial], { signal: controller.signal });
            } catch (error) {
              if (error instanceof FfmpegUnavailableError || controller.signal.aborted) throw error;
              throw new MediaError("MEDIA_MUX_FAILED", "Media tracks could not be combined.");
            }
            validateProbe(await probeMediaFile(partial, controller.signal), false, maxBytes);
            file = path.join(dir, "video.mp4");
            await fs.rename(partial, file);
          } else { file = path.join(dir, "video.mp4"); await fs.rename(video, file); }
        }
        let probe = await probeMediaFile(file, controller.signal);
        throwIfAborted(controller.signal);
        validateProbe(probe, audioOnly, maxBytes, options.purpose === "clips" ? 1 : 0);
        if (options.purpose === "transcript" && !probe.streams.some((s) => s.type === "audio")) {
          throw new MediaError("MEDIA_NO_AUDIO_TRACK", "Media has no audio track.");
        }
        const returnsAudioOnly = audioOnly || (options.purpose === "transcript" && !!set.progressive);
        if (returnsAudioOnly && !audioOnly) {
          const partial = path.join(dir, "audio.m4a.partial");
          const audioLimit = Math.min(AUDIO_BYTES, maxBytes);
          try {
            await runFfmpeg(["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", file,
              "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k",
              "-t", String(probe.durationSeconds), "-fs", String(audioLimit), "-f", "ipod", partial],
            { signal: controller.signal, timeoutMs: 180_000 });
          } catch (error) {
            if (error instanceof FfmpegUnavailableError || controller.signal.aborted) throw error;
            throw new MediaError("MEDIA_MUX_FAILED", "Media audio could not be extracted.");
          }
          const audioProbe = await probeMediaFile(partial, controller.signal);
          throwIfAborted(controller.signal);
          validateProbe(audioProbe, true, maxBytes);
          const audioSize = (await fs.stat(partial)).size;
          if (audioSize <= 0 || audioSize > audioLimit) {
            throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Extracted audio exceeded its size limit.");
          }
          if (Math.abs(audioProbe.durationSeconds - probe.durationSeconds) > 1) {
            throw new MediaError("MEDIA_PROBE_FAILED", "Extracted audio duration does not match its source.");
          }
          file = path.join(dir, "audio.m4a");
          await fs.rename(partial, file);
          probe = audioProbe;
        }
        const asset: MediaAsset = { source, ...(returnsAudioOnly ? { audioPath: file } : { videoPath: file }),
          durationSeconds: probe.durationSeconds, sizeBytes: probe.sizeBytes, hasVideo: probe.streams.some((s) => s.type === "video"),
          hasAudio: probe.streams.some((s) => s.type === "audio"), contentType: returnsAudioOnly ? "audio/mp4" : "video/mp4" };
        if (!returnsAudioOnly && set.split?.audio?.length) asset.audioPath = path.join(dir, "audio.m4a");
        leases.set(asset, { dir, releaseSlot }); acquired = true;
        return asset;
      } catch (error) {
        if (controller.signal.aborted || error instanceof FfmpegUnavailableError || (error instanceof MediaError && error.code === "MEDIA_LIMIT_EXCEEDED")) throw error;
        if (error instanceof FakeIpDnsError) fakeIpFailures++;
        lastError = error;
        for (const file of await fs.readdir(dir)) await fs.rm(path.join(dir, file), { force: true });
      }
    }
    if (fakeIpFailures === count && count > 0) throw new MediaError("MEDIA_FAKE_IP_DNS", "All media candidates resolved only to Fake-IP addresses.");
    if (lastError instanceof MediaError) throw lastError;
    throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media acquisition failed.", true);
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (timedOut) throw new MediaError("MEDIA_DOWNLOAD_TIMEOUT", "Media acquisition timed out.", true);
    throw error;
  } finally {
    clearTimeout(timer); unlink(); controller.abort();
    if (!acquired) await cleanupMediaTempDir(dir);
  }
}
export async function releaseMediaAsset(asset: MediaAsset): Promise<void> {
  const lease = leases.get(asset);
  if (!lease) return;
  lease.releasing ??= cleanupMediaTempDir(lease.dir).then(() => {
    leases.delete(asset);
    lease.releaseSlot();
  }).catch((error) => { lease.releasing = undefined; throw error; });
  await lease.releasing;
}
export async function withMediaAsset<T>(source: VideoSource, options: MediaAcquireOptions, fn: (asset: MediaAsset) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const asset = await acquireVideoMedia(source, options, signal);
  try { return await fn(asset); } finally { await releaseMediaAsset(asset); }
}
