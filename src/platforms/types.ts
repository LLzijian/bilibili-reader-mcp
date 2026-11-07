/**
 * Cross-platform video source contracts (frozen 2026-11-07).
 *
 * These types are the shared vocabulary between the platform layer
 * (src/platforms/, src/douyin/) and the media layer (src/media/).
 * Do not change field names or semantics without updating both consumers
 * and docs/tasks/2026-11-07-multiplatform-video-contracts.md.
 */

export type VideoPlatform = "bilibili" | "douyin";

/**
 * A normalized, platform-independent reference to one playable video.
 *
 * `videoId` is always a string: Douyin aweme ids are 64-bit and lose
 * precision when converted to Number. Bilibili uses the BV id.
 */
export interface VideoSource {
  platform: VideoPlatform;
  videoId: string;
  canonicalUrl: string;
  title: string;
  author?: string;
  durationSeconds: number;
  coverUrl?: string;
  /** Bilibili multi-part videos: 1-based page number. Absent elsewhere. */
  page?: number;
}

/**
 * One validated, downloadable media stream address.
 *
 * The platform layer must validate every URL before returning it:
 * https only, no userinfo, default port, and the hostname must match the
 * platform's media allowlist. The media layer re-validates against the
 * same policy before connecting (defense in depth).
 */
export interface MediaStreamCandidate {
  url: string;
  /** e.g. "video/mp4" or "audio/mp4". */
  mimeType: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  representationId?: string | number;
}

/**
 * The set of verified media addresses for a video. Exactly one of
 * `progressive` / `split` must be present and non-empty.
 */
export interface MediaCandidateSet {
  /** Progressive file containing both video and audio (typical for Douyin). */
  progressive?: MediaStreamCandidate[];
  /** Separate video/audio tracks that require muxing (typical for Bilibili DASH). */
  split?: {
    video: MediaStreamCandidate[];
    audio?: MediaStreamCandidate[];
  };
  durationSeconds?: number;
  /**
   * Extra static, non-credential headers the CDN requires (e.g. Referer).
   * The media layer must reject sets containing Cookie, Authorization or
   * Proxy-Authorization keys.
   */
  requestHeaders?: Record<string, string>;
}

/**
 * Platform identity + metadata resolution. Implementations live in
 * src/platforms/ (registry) and src/douyin/ (Douyin adapter).
 *
 * Media candidate resolution is modeled separately as
 * `PlatformMediaSource` in src/media/types.ts so the media pipeline never
 * depends on platform page parsing and vice versa.
 */
export interface VideoPlatformAdapter {
  readonly platform: VideoPlatform;
  /** Pure host/path check. Must not perform network I/O. */
  canHandle(input: URL): boolean;
  /**
   * Resolve a user-supplied URL (or share text containing one) into a
   * normalized VideoSource. May perform bounded network I/O (short-link
   * expansion, metadata lookup). Never throws raw parser errors to MCP
   * callers: use PlatformError / ValidationError from utils/errors.js.
   */
  resolve(input: string, signal?: AbortSignal): Promise<VideoSource>;
}
