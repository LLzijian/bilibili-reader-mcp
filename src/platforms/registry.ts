import { douyinAdapter } from "../douyin/adapter.js";
import { getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { isValidBVId } from "../utils/bvid.js";
import { PlatformError } from "../utils/errors.js";
import { bilibiliAdapter } from "./bilibili-adapter.js";
import type { VideoPlatformAdapter, VideoPlatform, VideoSource } from "./types.js";
import { extractUrlsFromText, normalizePlatformUrl } from "./url.js";

const adapters: readonly VideoPlatformAdapter[] = Object.freeze([bilibiliAdapter, douyinAdapter]);
export function listPlatformAdapters(): readonly VideoPlatformAdapter[] { return adapters; }
export function findAdapterForUrl(input: URL): VideoPlatformAdapter | undefined {
  if (!normalizePlatformUrl(input.href)) return undefined;
  return adapters.find((adapter) => adapter.canHandle(input));
}
export function detectPlatform(input: string): VideoPlatform | undefined {
  if (input.length <= 65_536 && isValidBVId(input.trim())) return "bilibili";
  for (const raw of extractUrlsFromText(input)) {
    const url = normalizePlatformUrl(raw);
    const adapter = url && findAdapterForUrl(url);
    if (adapter) return adapter.platform;
  }
  return undefined;
}
export function getAdapter(platform: VideoPlatform): VideoPlatformAdapter {
  const adapter = adapters.find((item) => item.platform === platform);
  if (!adapter) throw new PlatformError("UNSUPPORTED_PLATFORM", "This video platform is not supported.");
  return adapter;
}
export async function resolveVideoSource(input: string, signal?: AbortSignal): Promise<VideoSource> {
  signal = getOperationSignal(signal);
  throwIfAborted(signal);
  // BV identifiers are a supported legacy entry point without a URL.
  if (input.length <= 65_536 && isValidBVId(input.trim())) return bilibiliAdapter.resolve(input.trim(), signal);
  for (const raw of extractUrlsFromText(input)) {
    const url = normalizePlatformUrl(raw);
    const adapter = url && findAdapterForUrl(url);
    if (adapter) return adapter.resolve(url!.href, signal);
  }
  throw new PlatformError("UNSUPPORTED_PLATFORM", "No supported HTTPS video link was found.");
}
