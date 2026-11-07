import { config } from "../config.js";
import { getPlaybackAudioSet } from "../bilibili/playback.js";
import { parseVideoCandidates } from "../bilibili/frames.js";
import { resolvePartCid } from "../bilibili/navigation.js";
import { fetchWithoutWBI } from "../bilibili/http.js";
import { SECURITY_LIMITS } from "../security/limits.js";
import { runWithOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { credentialManager } from "../utils/credentials.js";
import { AsrError, MediaError } from "../utils/errors.js";
import type { PlatformMediaSource } from "./types.js";

export interface BilibiliMediaSourceDependencies {
  resolvePartCid?: typeof resolvePartCid;
  getPlaybackAudioSet?: typeof getPlaybackAudioSet;
  fetchPlayurl?: typeof fetchWithoutWBI;
}
export function createBilibiliMediaSource(deps: BilibiliMediaSourceDependencies = {}): PlatformMediaSource {
  return {
    platform: "bilibili",
    async getMediaCandidates(source, signal) {
      throwIfAborted(signal);
      try {
        const { cid } = await runWithOperationSignal(signal, () => (deps.resolvePartCid ?? resolvePartCid)(source.videoId, source.page));
        throwIfAborted(signal);
        const fetchPlayurl = deps.fetchPlayurl ?? fetchWithoutWBI;
        const audio = await (deps.getPlaybackAudioSet ?? getPlaybackAudioSet)(source.videoId, cid, fetchPlayurl, signal);
        throwIfAborted(signal);
        const raw = await fetchPlayurl("/x/player/playurl", { bvid: source.videoId, cid, fnval: 16, fnver: 0, qn: 80 },
          { ...credentialManager.getAuthHeaders(), "User-Agent": config.userAgent, Referer: config.referer }, signal, SECURITY_LIMITS.playbackJsonBytes);
        throwIfAborted(signal);
        return { split: { video: parseVideoCandidates(raw), ...(audio.candidates.length ? { audio: audio.candidates } : {}) },
          durationSeconds: audio.durationSeconds ?? source.durationSeconds,
          requestHeaders: { "User-Agent": config.userAgent, Referer: config.referer } };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof AsrError && error.code === "ASR_LIMIT_EXCEEDED") throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media duration exceeded its limit.");
        throw new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "Bilibili media candidates are unavailable.", true);
      }
    },
  };
}
