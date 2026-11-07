import { extractUrlsFromText, normalizePlatformUrl } from "../platforms/url.js";
import { PlatformError } from "../utils/errors.js";

// Share-page hosts used by the public claude-video-reader/douyin.py parser.
export const DOUYIN_PAGE_HOSTS = ["www.douyin.com", "v.douyin.com", "www.iesdouyin.com"] as const;

export function isDouyinPageUrl(url: URL): boolean {
  return !!normalizePlatformUrl(url.href) && DOUYIN_PAGE_HOSTS.some((host) => host === url.hostname);
}

export function douyinVideoId(url: URL): string | undefined {
  if (!isDouyinPageUrl(url) || url.hostname === "v.douyin.com") return undefined;
  return /^\/(?:video|share\/video)\/([0-9]{1,25})\/?$/.exec(url.pathname)?.[1];
}

export function canHandleDouyinUrl(url: URL): boolean {
  return isDouyinPageUrl(url) && (url.hostname === "v.douyin.com"
    ? /^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)
    : douyinVideoId(url) !== undefined);
}

export function parseDouyinInput(input: string): URL {
  for (const raw of extractUrlsFromText(input)) {
    const url = normalizePlatformUrl(raw);
    if (url && canHandleDouyinUrl(url)) return url;
  }
  throw new PlatformError("PLATFORM_URL_INVALID", "An approved HTTPS Douyin video URL is required.");
}

export function canonicalDouyinUrl(id: string): string {
  if (!/^[0-9]{1,25}$/.test(id)) throw new PlatformError("PLATFORM_URL_INVALID", "Invalid Douyin video ID.");
  return `https://www.douyin.com/video/${id}`;
}
