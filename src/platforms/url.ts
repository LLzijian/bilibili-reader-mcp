import { PlatformError } from "../utils/errors.js";

export function extractUrlsFromText(text: string): string[] {
  if (typeof text !== "string" || text.length > 65_536 || Buffer.byteLength(text, "utf8") > 65_536) {
    throw new PlatformError("PLATFORM_URL_INVALID", "Video share text exceeds the 64 KiB limit.");
  }
  const result: string[] = [];
  // Chinese prose cannot be part of these platforms' ASCII video paths.
  const pattern = /https?:\/\/[^\s<>"'　-〿＀-￯㐀-鿿]+/giu;
  for (const match of text.matchAll(pattern)) {
    const url = match[0].replace(/[)\]}.!,;:]+$/u, "");
    if (url && !result.includes(url)) result.push(url);
    if (result.length === 16) break;
  }
  return result;
}

export function normalizePlatformUrl(raw: string): URL | undefined {
  if (typeof raw !== "string" || raw.length > 8_192 || /[\u0000- \u007f\\]/u.test(raw) || /^https:\/\/[^/?#]*@/i.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname) return undefined;
    url.hash = "";
    return url;
  } catch { return undefined; }
}
