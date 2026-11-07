import { getVideoMetadataData } from "../bilibili/metadata.js";
import { extractBVId, isValidBVId } from "../utils/bvid.js";
import { PlatformError } from "../utils/errors.js";
import { boundedRemoteText } from "../utils/bounded-text.js";
import { getOperationSignal, runWithOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { extractUrlsFromText, normalizePlatformUrl } from "./url.js";
import type { VideoPlatformAdapter } from "./types.js";

export const bilibiliAdapter: VideoPlatformAdapter = {
  platform: "bilibili",
  canHandle(input) {
    return !!normalizePlatformUrl(input.href) && (
      (input.hostname === "www.bilibili.com" && /^\/video\/BV[A-Za-z0-9]{10}\/?$/.test(input.pathname)) ||
      (input.hostname === "b23.tv" && /^\/[A-Za-z0-9_-]{1,128}\/?$/.test(input.pathname))
    );
  },
  async resolve(input, signal) {
    signal = getOperationSignal(signal);
    throwIfAborted(signal);
    const direct = isValidBVId(input.trim());
    const url = direct ? undefined : extractUrlsFromText(input).map(normalizePlatformUrl).find((value) => value && bilibiliAdapter.canHandle(value));
    if (!direct && !url) throw new PlatformError("PLATFORM_URL_INVALID", "A Bilibili BV ID or approved HTTPS video URL is required.");
    let bvid: string;
    try { bvid = extractBVId(direct ? input.trim() : url!.href); }
    catch { throw new PlatformError("PLATFORM_RESOLVE_FAILED", "This Bilibili short link does not expose a BV ID; provide its full video URL."); }
    const pageText = url?.searchParams.get("p");
    if (pageText !== undefined && pageText !== null && (!/^[1-9]\d{0,8}$/.test(pageText))) throw new PlatformError("PLATFORM_URL_INVALID", "Bilibili page must be a positive integer.");
    const page = pageText ? Number(pageText) : 1;
    const metadata = await runWithOperationSignal(signal, () => getVideoMetadataData(bvid));
    throwIfAborted(signal);
    const part = metadata.pages.find((item) => item.page === page);
    if (!part && (metadata.pages.length > 0 || page !== 1)) throw new PlatformError("PLATFORM_URL_INVALID", "The selected Bilibili video part does not exist.");
    const durationSeconds = part?.duration ?? metadata.duration;
    if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new PlatformError("PLATFORM_RESOLVE_FAILED", "Bilibili did not provide the selected part's duration.");
    return { platform: "bilibili", videoId: bvid, canonicalUrl: `https://www.bilibili.com/video/${bvid}?p=${page}`,
      title: boundedRemoteText(metadata.title, 512), author: boundedRemoteText(metadata.author, 128) || undefined,
      durationSeconds, page };
  },
};
