import { describe, expect, it, vi } from "vitest";
import { createBilibiliMediaSource } from "../src/media/bilibili-source.js";
import { ensureDefaultMediaSources } from "../src/media/default-sources.js";
import { getRegisteredMediaSource } from "../src/media/acquire.js";
import type { VideoSource } from "../src/platforms/types.js";
const source: VideoSource = { platform: "bilibili", videoId: "BV1xx411c7mD", canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD", title: "synthetic", durationSeconds: 2, page: 2 };
const video = { id: 80, mimeType: "video/mp4", codecs: "avc1.640032", height: 1080, bandwidth: 100, baseUrl: "https://video.bilivideo.com/video.mp4" };
const audio = { url: "https://audio.bilivideo.com/audio.m4a", mimeType: "audio/mp4", bandwidth: 10, representationId: 30216 };
function dependencies() {
  return { resolvePartCid: vi.fn(async () => ({ cid: 2 })) as never, getPlaybackAudioSet: vi.fn(async () => ({ candidates: [audio], durationSeconds: 2 })), fetchPlayurl: vi.fn(async () => ({ dash: { video: [video] } })) };
}
describe("Bilibili media source adapter", () => {
  it("combines existing audio and AVC video parsers without CDN credentials", async () => {
    const deps = dependencies();
    const set = await createBilibiliMediaSource(deps).getMediaCandidates(source);
    expect(set).toMatchObject({ durationSeconds: 2, split: { audio: [audio], video: [{ url: video.baseUrl, mimeType: "video/mp4" }] } });
    expect(deps.resolvePartCid).toHaveBeenCalledWith(source.videoId, 2);
    expect(deps.fetchPlayurl.mock.calls[0][1]).toMatchObject({ bvid: source.videoId, cid: 2, fnval: 16 });
    expect(new Headers(set.requestHeaders).has("cookie")).toBe(false);
  });
  it("preserves a valid video-only source", async () => {
    const deps = dependencies(); deps.getPlaybackAudioSet.mockResolvedValue({ candidates: [], durationSeconds: 2 });
    const set = await createBilibiliMediaSource(deps).getMediaCandidates(source); expect(set.split?.audio).toBeUndefined(); expect(set.split?.video).toHaveLength(1);
  });
  it("rejects malformed video responses without URL leakage", async () => {
    const deps = dependencies(); deps.fetchPlayurl.mockResolvedValue({ dash: { video: [{ ...video, baseUrl: "https://evil.test/file?secret=hidden" }] } });
    await expect(createBilibiliMediaSource(deps).getMediaCandidates(source)).rejects.toMatchObject({ code: "MEDIA_CANDIDATES_UNAVAILABLE", message: "Bilibili media candidates are unavailable." });
  });
  it("does no work for a pre-cancelled source", async () => {
    const deps = dependencies(); await expect(createBilibiliMediaSource(deps).getMediaCandidates(source, AbortSignal.abort())).rejects.toHaveProperty("name", "AbortError"); expect(deps.resolvePartCid).not.toHaveBeenCalled();
  });
  it("registers both default sources idempotently", () => {
    ensureDefaultMediaSources();
    const first = getRegisteredMediaSource("bilibili");
    const douyin = getRegisteredMediaSource("douyin");
    ensureDefaultMediaSources();
    expect(first?.platform).toBe("bilibili");
    expect(douyin?.platform).toBe("douyin");
    expect(getRegisteredMediaSource("bilibili")).toBe(first);
    expect(getRegisteredMediaSource("douyin")).toBe(douyin);
  });
});
