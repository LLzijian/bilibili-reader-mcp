import type { PlatformMediaSource } from "../media/types.js";
import type { VideoPlatformAdapter } from "../platforms/types.js";
import { getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { PlatformError } from "../utils/errors.js";
import { loadDouyinVideo, type DouyinMetadataDependencies } from "./metadata.js";
import { parseDouyinMediaCandidates } from "./playback.js";
import { canHandleDouyinUrl, canonicalDouyinUrl } from "./url.js";

export function createDouyinAdapter(dependencies: DouyinMetadataDependencies = {}): VideoPlatformAdapter & PlatformMediaSource {
  return {
    platform: "douyin",
    canHandle: canHandleDouyinUrl,
    async resolve(input, signal) {
      return (await loadDouyinVideo(input, signal, dependencies)).source;
    },
    async getMediaCandidates(source, signal) {
      signal = getOperationSignal(signal);
      throwIfAborted(signal);
      if (source.platform !== "douyin") throw new PlatformError("PLATFORM_URL_INVALID", "A Douyin video source is required.");
      const video = await loadDouyinVideo(canonicalDouyinUrl(source.videoId), signal, dependencies);
      throwIfAborted(signal);
      return parseDouyinMediaCandidates(video);
    },
  };
}
export const douyinAdapter: VideoPlatformAdapter & PlatformMediaSource = createDouyinAdapter();
