import type { VideoSource } from "../platforms/types.js";
import { normalizePlatformUrl } from "../platforms/url.js";
import { getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { boundedRemoteText, sanitizeRemoteText } from "../utils/bounded-text.js";
import { PlatformError } from "../utils/errors.js";
import { fetchDouyinPage, MAX_DOUYIN_HTML_BYTES, type DouyinPage } from "./http.js";
import { canonicalDouyinUrl, douyinVideoId, parseDouyinInput } from "./url.js";

export const DOUYIN_JSON_LIMITS = Object.freeze({ depth: 32, nodes: 20_000, string: 262_144, array: 256, keys: 1_024 });
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function invalid(message = "Douyin page contains invalid or unsupported video data."): never {
  throw new PlatformError("PLATFORM_RESOLVE_FAILED", message);
}

// Scan BEFORE JSON.parse: bound nesting, tokens and string lengths, respecting
// escaped quotes/braces. Never evaluate page scripts or use a greedy JSON regex.
function parseJsonPrefix(text: string): unknown {
  let depth = 0, tokens = 0, stringStart = -1, end = -1;
  let quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (i - stringStart > DOUYIN_JSON_LIMITS.string) invalid("Douyin JSON string limit exceeded.");
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; stringStart = i; tokens++; }
    else if (ch === "{" || ch === "[") { depth++; tokens++; }
    else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
    else if (ch === "," || ch === ":") tokens++;
    if (depth > DOUYIN_JSON_LIMITS.depth || depth < 0 || tokens > DOUYIN_JSON_LIMITS.nodes * 4) invalid("Douyin JSON complexity limit exceeded.");
  }
  if (end < 0) invalid();
  let data: unknown;
  try { data = JSON.parse(text.slice(0, end)); } catch { invalid(); }
  const queue: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const current = queue.pop()!;
    if (++nodes > DOUYIN_JSON_LIMITS.nodes || current.depth > DOUYIN_JSON_LIMITS.depth) invalid("Douyin JSON complexity limit exceeded.");
    const value = current.value;
    if (typeof value === "string" && value.length > DOUYIN_JSON_LIMITS.string) invalid();
    if (Array.isArray(value) && value.length > DOUYIN_JSON_LIMITS.array) invalid("Douyin JSON array limit exceeded.");
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > (Array.isArray(value) ? DOUYIN_JSON_LIMITS.array : DOUYIN_JSON_LIMITS.keys)) invalid();
      for (const [key, child] of entries) {
        if (key.length > 1_024 || queue.length + nodes >= DOUYIN_JSON_LIMITS.nodes) invalid();
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return data;
}

function embeddedData(html: string): unknown {
  const scripts = /<script\b[^>]{0,4096}>/gi;
  const lower = html.toLowerCase();
  let match: RegExpExecArray | null;
  let matches = 0;
  while ((match = scripts.exec(html))) {
    const end = lower.indexOf("</script", scripts.lastIndex);
    if (end < 0) break;
    const body = html.slice(scripts.lastIndex, end);
    scripts.lastIndex = end + 8;
    const render = /\bid\s*=\s*["']RENDER_DATA["']/i.test(match[0]);
    const routerTag = /\bid\s*=\s*["']_ROUTER_DATA["']/i.test(match[0]);
    const assignment = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(body);
    if (!render && !routerTag && !assignment) continue;
    if (++matches > 16) invalid();
    let text = assignment ? body.slice(assignment.index + assignment[0].length) : body;
    if (render) { try { text = decodeURIComponent(text); } catch { invalid(); } }
    text = text.trimStart();
    if (!text.startsWith("{") && !text.startsWith("[")) invalid();
    return parseJsonPrefix(text);
  }
  // Inspect only when no data exists: a video description mentioning login or
  // captcha is not evidence that the page is an access wall.
  if (/captcha|verify[-_]center|验证码|安全验证/i.test(html)) throw new PlatformError("DOUYIN_CHALLENGE_REQUIRED", "Douyin requires interactive verification.");
  if (/登录后|请先登录|登录即可|login[-_ ]?(?:required|wall)/i.test(html)) throw new PlatformError("DOUYIN_ACCESS_DENIED", "Douyin requires authorized access to this video.");
  if (/已删除|不存在|已下架/.test(html)) throw new PlatformError("DOUYIN_VIDEO_UNAVAILABLE", "This Douyin video has been removed.");
  if (/私密|仅自己可见/.test(html)) throw new PlatformError("DOUYIN_ACCESS_DENIED", "This Douyin video is private.");
  invalid("Douyin page did not contain supported embedded video data.");
}

export interface DouyinVideo { source: VideoSource; item: JsonObject; description: string; }

export function parseDouyinVideoPage(html: string, expectedId: string): DouyinVideo {
  canonicalDouyinUrl(expectedId);
  if (html.length > MAX_DOUYIN_HTML_BYTES || Buffer.byteLength(html, "utf8") > MAX_DOUYIN_HTML_BYTES) invalid("Douyin HTML exceeds the 4 MiB limit.");
  const data = embeddedData(html);
  const queue: unknown[] = [data];
  let item: JsonObject | undefined;
  while (queue.length) {
    const value = queue.pop();
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const candidate = object(value);
    if (!candidate) continue;
    if ((candidate.aweme_id ?? candidate.awemeId) === expectedId) {
      item = candidate;
      break;
    }
    queue.push(...Object.values(candidate));
  }
  if (!item) invalid("Douyin page did not contain the requested video ID as a string.");
  const status = object(item.status);
  if (item.is_deleted === true || status?.is_delete === true || status?.is_delete === 1 || item.is_delete === true) throw new PlatformError("DOUYIN_VIDEO_UNAVAILABLE", "This Douyin video has been removed.");
  if (item.is_private === true || (typeof status?.private_status === "number" && status.private_status !== 0) || status?.is_prohibited === true) throw new PlatformError("DOUYIN_ACCESS_DENIED", "This Douyin video is private or restricted.");
  if (item.images || item.image_post_info || item.aweme_type === 68 || item.aweme_type === 2) throw new PlatformError("DOUYIN_VIDEO_UNAVAILABLE", "Douyin image posts are not supported.");
  if (item.live_room || item.room_id || item.aweme_type === 101) throw new PlatformError("DOUYIN_VIDEO_UNAVAILABLE", "Douyin live streams are not supported.");
  if (item.is_ads === true || item.is_ads === 1) throw new PlatformError("DOUYIN_VIDEO_UNAVAILABLE", "Douyin advertisement objects are not supported.");
  const video = object(item.video);
  const description = boundedRemoteText(sanitizeRemoteText(item.desc), 20_000);
  const title = boundedRemoteText(description, 512);
  const duration = video?.duration ?? item.duration;
  if (!video || !title || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) invalid("Douyin video is missing its title, video object or duration.");
  const author = object(item.author);
  const cover = object(video.cover ?? video.origin_cover);
  const covers = cover?.url_list ?? cover?.urlList;
  let coverUrl: string | undefined;
  if (Array.isArray(covers) && typeof covers[0] === "string") {
    const cleaned = sanitizeRemoteText(covers[0]);
    if (cleaned.length <= 4_096) coverUrl = normalizePlatformUrl(cleaned)?.href;
  }
  return {
    source: { platform: "douyin", videoId: expectedId, canonicalUrl: canonicalDouyinUrl(expectedId), title,
      author: boundedRemoteText(sanitizeRemoteText(author?.nickname ?? author?.nick_name), 128) || undefined,
      durationSeconds: duration / 1_000, ...(coverUrl ? { coverUrl } : {}) },
    item, description,
  };
}

export interface DouyinMetadataDependencies { fetchPage?: (input: string | URL, signal?: AbortSignal) => Promise<DouyinPage>; }
export async function loadDouyinVideo(input: string, signal?: AbortSignal, dependencies: DouyinMetadataDependencies = {}): Promise<DouyinVideo> {
  signal = getOperationSignal(signal);
  throwIfAborted(signal);
  const url = parseDouyinInput(input);
  const fetchPage = dependencies.fetchPage ?? fetchDouyinPage;
  let id = douyinVideoId(url);
  if (!id) {
    const expanded = await fetchPage(url, signal);
    throwIfAborted(signal);
    id = douyinVideoId(expanded.url);
    if (!id) invalid("Douyin short link did not resolve to a supported video URL.");
  }
  const page = await fetchPage(`https://www.iesdouyin.com/share/video/${id}/`, signal);
  throwIfAborted(signal);
  const redirectedId = douyinVideoId(page.url);
  if (redirectedId !== id) invalid("Douyin page redirected away from the requested video.");
  return parseDouyinVideoPage(page.html, id);
}
