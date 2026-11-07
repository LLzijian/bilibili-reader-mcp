import { douyinAdapter } from "../douyin/adapter.js";
import { douyinMediaFetch } from "../douyin/http.js";
import { getRegisteredMediaSource, registerMediaSource, setPlatformMediaFetch } from "./acquire.js";
import { createBilibiliMediaSource } from "./bilibili-source.js";

export function ensureDefaultMediaSources(): void {
  if (!getRegisteredMediaSource("bilibili")) registerMediaSource(createBilibiliMediaSource());
  if (!getRegisteredMediaSource("douyin")) {
    registerMediaSource(douyinAdapter);
    setPlatformMediaFetch("douyin", douyinMediaFetch);
  }
}
