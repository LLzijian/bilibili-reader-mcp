/**
 * Unified media pipeline contracts (frozen 2026-11-07).
 *
 * The media layer (src/media/) turns a VideoSource into a verified local
 * MediaAsset and owns every temporary resource behind it. Callers receive
 * plain data only; the temporary directory lease is tracked internally and
 * released via releaseMediaAsset()/withMediaAsset(). Never serialize a
 * cleanup function into an MCP response.
 */

import type {
  MediaCandidateSet,
  VideoPlatform,
  VideoSource,
} from "../platforms/types.js";

/**
 * Provides verified media candidates for one platform. Implemented per
 * platform (Bilibili: src/media/bilibili-source.ts, Douyin:
 * src/douyin/adapter.ts) and registered through registerMediaSource().
 */
export interface PlatformMediaSource {
  readonly platform: VideoPlatform;
  /**
   * Return validated CDN candidates for the source. No downloading here:
   * the media layer downloads, muxes and probes.
   */
  getMediaCandidates(
    source: VideoSource,
    signal?: AbortSignal,
  ): Promise<MediaCandidateSet>;
}

/** Why the caller needs local media; drives acquisition strategy. */
export type MediaPurpose = "transcript" | "frames" | "keyframes" | "clips";

export interface MediaAcquireOptions {
  purpose: MediaPurpose;
  /**
   * Optional per-call byte budget. The media layer clamps it to the
   * process ceiling (512 MiB video) and rejects invalid values.
   */
  maxBytes?: number;
}

/**
 * A verified local media asset owned by an internal temp lease.
 * At least one of videoPath/audioPath is present; hasVideo/hasAudio tell
 * the caller which tasks are possible. Paths are created by the media
 * layer inside its own registered temp directory and are never derived
 * from MCP input.
 */
export interface MediaAsset {
  source: VideoSource;
  /** Local file containing a video track (may also contain audio). */
  videoPath?: string;
  /** Local audio-only file, when acquired or extracted separately. */
  audioPath?: string;
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  contentType?: string;
  sizeBytes: number;
}
