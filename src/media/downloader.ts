import fs from "node:fs/promises";
import path from "node:path";
import { createAbortError, getOperationSignal, linkAbortSignal, throwIfAborted } from "../security/operation-context.js";
import { FakeIpDnsError } from "../security/pinned-https.js";
import { MediaError } from "../utils/errors.js";
import { isRegisteredMediaTempDir } from "./temp.js";

export type PlatformMediaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface MediaDownloadOptions {
  fetchFn: PlatformMediaFetch;
  maxBytes: number;
  budget?: { remainingBytes: number };
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  validateUrl?: (url: string) => string;
}
export function validateMediaUrl(input: string): string {
  try {
    if (typeof input !== "string" || input.length > 8192) throw new Error();
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname) throw new Error();
    return url.toString();
  } catch { throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media location."); }
}
export function validateMediaHeaders(headers: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries(headers)) {
    if (["cookie", "authorization", "proxy-authorization"].includes(key.trim().toLowerCase()) || typeof value !== "string") {
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Credential headers are forbidden for media downloads.");
    }
  }
  try { new Headers(headers); } catch { throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media headers."); }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
export async function downloadMediaFile(url: string, destination: string, options: MediaDownloadOptions): Promise<number> {
  const caller = getOperationSignal(options.signal);
  throwIfAborted(caller);
  validateMediaHeaders(options.headers);
  const target = path.resolve(destination);
  const dir = path.dirname(target);
  if (!isRegisteredMediaTempDir(dir) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > 512 * 1024 * 1024) {
    throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media download destination or budget.");
  }
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("directory");
  } catch { throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Unsafe media download directory."); }
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media download deadline.");
  const controller = new AbortController();
  const unlink = linkAbortSignal(caller, controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const signal = controller.signal;
  const budget = options.budget ?? { remainingBytes: options.maxBytes };
  const validate = (value: string) => (options.validateUrl ?? validateMediaUrl)(validateMediaUrl(value));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const partial = target + ".partial";
  let ownsPartial = false;
  try {
    let current = validate(url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const fetched: Response = await abortable(options.fetchFn(current, { method: "GET", headers: options.headers, redirect: "manual", credentials: "omit", signal }).then((value) => {
        if (signal.aborted) { void value.body?.cancel().catch(() => {}); throw createAbortError(); }
        return value;
      }), signal);
      response = fetched;
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirects === 3 || !location) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media redirect limit exceeded or location missing.");
      try { current = validate(new URL(location, current).toString()); }
      catch { throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media redirect."); }
    }
    if (!response?.ok) { await response?.body?.cancel(); throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media request failed.", true); }
    reader = response.body?.getReader();
    if (!reader) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media response has no body.");
    const length = response.headers.get("content-length");
    let expected: number | undefined;
    if (length !== null) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Invalid media response length.");
      expected = Number(length);
      if (expected > options.maxBytes || expected > budget.remainingBytes) throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media download byte budget exceeded.");
    }
    const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!["video/mp4", "audio/mp4", "audio/m4a", "audio/x-m4a", "application/octet-stream"].includes(type)) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Unsupported media content type.");
    handle = await fs.open(partial, "wx", 0o600);
    ownsPartial = true;
    let received = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      budget.remainingBytes -= value.byteLength;
      if (received > options.maxBytes || budget.remainingBytes < 0) throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media download byte budget exceeded.");
      await handle.writeFile(value);
    }
    throwIfAborted(signal);
    if (received === 0 || (expected !== undefined && received !== expected)) throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media response was incomplete.", true);
    await handle.close(); handle = undefined;
    await fs.rename(partial, target);
    return received;
  } catch (error) {
    if (caller?.aborted) throw createAbortError();
    if (timedOut) throw new MediaError("MEDIA_DOWNLOAD_TIMEOUT", "Media download timed out.", true);
    if (error instanceof MediaError || error instanceof FakeIpDnsError) throw error;
    throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Media download failed.", true);
  } finally {
    clearTimeout(timer); unlink(); controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    await handle?.close();
    if (ownsPartial) await fs.rm(partial, { force: true });
  }
}
