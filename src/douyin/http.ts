import { createPinnedHttpsFetch, type PinnedHttpsFetchOptions } from "../security/pinned-https.js";
import { getOperationSignal, linkAbortSignal, throwIfAborted } from "../security/operation-context.js";
import { readBoundedResponseBytes } from "../utils/bounded-response.js";
import { PlatformError } from "../utils/errors.js";
import { normalizePlatformUrl } from "../platforms/url.js";
import { isDouyinPageUrl } from "./url.js";

// Public evidence: https://www.mxnzp.com/doc/42 (video.play_addr_h264 /
// bit_rate[].play_addr.url_list responses), and
// https://github.com/MgOxides/douyin-downloader/blob/main/scripts/pipeline.py
// (captures douyinvod.com responses). No broader ByteDance domain is trusted.
export const DOUYIN_MEDIA_HOST_SUFFIXES = Object.freeze([".douyinvod.com"]);
export const DOUYIN_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1";
export const MAX_DOUYIN_HTML_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function validateDouyinMediaUrl(raw: unknown): string {
  const url = typeof raw === "string" ? normalizePlatformUrl(raw) : undefined;
  if (!url || !DOUYIN_MEDIA_HOST_SUFFIXES.some((suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix))) {
    throw new PlatformError("DOUYIN_MEDIA_UNAVAILABLE", "Douyin returned an unsupported media location.");
  }
  return url.href;
}

export interface DouyinPage { url: URL; html: string; }

/** The optional transport injection is for synthetic tests; no global fetch is used. */
export function createDouyinHttp(options: PinnedHttpsFetchOptions = {}) {
  const pageFetch = createPinnedHttpsFetch({
    allowedHostSuffixes: [".www.douyin.com", ".v.douyin.com", ".www.iesdouyin.com"],
    allowPublicDnsFallback: false,
  });
  const mediaFetch = createPinnedHttpsFetch({ allowedHostSuffixes: DOUYIN_MEDIA_HOST_SUFFIXES, allowPublicDnsFallback: false });

  async function follow(input: string | URL | Request, init: RequestInit, media: boolean): Promise<{ response: Response; url: URL }> {
    let url = normalizePlatformUrl(input instanceof Request ? input.url : input.toString());
    const signal = getOperationSignal(init.signal ?? (input instanceof Request ? input.signal : undefined));
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET") throw new PlatformError("PLATFORM_URL_INVALID", "Douyin requests only support GET.");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    // Only static, non-credential headers can cross redirects. In particular,
    // caller Host/Range/forwarding headers must not affect the pinned request.
    const safeHeaders = new Headers({ "User-Agent": DOUYIN_USER_AGENT, Referer: "https://www.douyin.com/" });
    for (const key of ["user-agent", "referer", "accept"]) {
      if (headers.has(key)) safeHeaders.set(key, headers.get(key)!);
    }
    for (let redirects = 0; ; redirects++) {
      throwIfAborted(signal);
      if (!url || (!media && !isDouyinPageUrl(url))) {
        throw new PlatformError("PLATFORM_URL_INVALID", "Douyin redirect has an unsupported destination.");
      }
      if (media) validateDouyinMediaUrl(url.href);
      // First version deliberately uses public pages only. DOUYIN_COOKIE is
      // never read or forwarded; login/challenge walls return explicit errors.
      const response = await (media ? mediaFetch : pageFetch)(url, { method: "GET", headers: safeHeaders, signal }, options);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new PlatformError("PLATFORM_RESOLVE_FAILED", "Douyin returned an unsupported redirect response.");
        }
        return { response, url };
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirects >= MAX_REDIRECTS || !location) throw new PlatformError("PLATFORM_RESOLVE_FAILED", "Douyin redirect limit exceeded or redirect is invalid.");
      try { url = normalizePlatformUrl(new URL(location, url).href); }
      catch { url = undefined; }
    }
  }

  return {
    async fetchPage(input: string | URL, signal?: AbortSignal): Promise<DouyinPage> {
      const controller = new AbortController();
      const unlink = linkAbortSignal(getOperationSignal(signal), controller);
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const { response, url } = await follow(input, { signal: controller.signal }, false);
        if (!response.ok) {
          await response.body?.cancel();
          throw new PlatformError(response.status === 401 || response.status === 403 ? "DOUYIN_ACCESS_DENIED" : "DOUYIN_VIDEO_UNAVAILABLE", "Douyin did not allow this page to be read.");
        }
        const bytes = await readBoundedResponseBytes(response, MAX_DOUYIN_HTML_BYTES, "douyin_html");
        throwIfAborted(controller.signal);
        return { url, html: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch (error) {
        throwIfAborted(controller.signal);
        if (error instanceof PlatformError) throw error;
        throw new PlatformError("PLATFORM_RESOLVE_FAILED", "Unable to read a bounded public Douyin page.");
      } finally { clearTimeout(timer); unlink(); controller.abort(); }
    },
    async mediaFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
      return (await follow(input, init, true)).response;
    },
  };
}

const defaultHttp = createDouyinHttp();
export const fetchDouyinPage = defaultHttp.fetchPage;
export function douyinMediaFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return defaultHttp.mediaFetch(input, init);
}
