import { afterEach, describe, expect, it, vi } from "vitest";
import { extractUrlsFromText, normalizePlatformUrl } from "../src/platforms/url.js";
import { detectPlatform, findAdapterForUrl, getAdapter, listPlatformAdapters, resolveVideoSource } from "../src/platforms/registry.js";
import { bilibiliAdapter } from "../src/platforms/bilibili-adapter.js";
import { getVideoMetadataData } from "../src/bilibili/metadata.js";
vi.mock("../src/bilibili/metadata.js", () => ({ getVideoMetadataData: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("platform URL entry points", () => {
  it("extracts share URLs without surrounding Chinese punctuation or prose", () => {
    expect(extractUrlsFromText("分享：https://v.douyin.com/Abc123/）。后续文字 https://www.bilibili.com/video/BV1T6PQzQErF，结束"))
      .toEqual(["https://v.douyin.com/Abc123/", "https://www.bilibili.com/video/BV1T6PQzQErF"]);
  });
  it("bounds bytes and results", () => {
    expect(() => extractUrlsFromText("中".repeat(22_000))).toThrow(expect.objectContaining({ code: "PLATFORM_URL_INVALID" }));
    expect(extractUrlsFromText(Array.from({ length: 25 }, (_, i) => `https://v.douyin.com/${i}/`).join(" "))).toHaveLength(16);
  });
  it.each(["http://www.douyin.com/video/1", "https://user:pass@www.douyin.com/video/1", "https://@www.douyin.com/video/1", "https://www.douyin.com:8080/video/1", "file:///video/1", "https://www.douyin.com\\@evil.com/video/1", "https://www.douyin.com/\nvideo/1"])("rejects unsafe URL %s", (raw) => expect(normalizePlatformUrl(raw)).toBeUndefined());
  it("normalizes default port and removes fragment", () => expect(normalizePlatformUrl("https://www.douyin.com:443/video/1#x")?.href).toBe("https://www.douyin.com/video/1"));
  it("detects adapters purely and retains direct BV identifiers", () => {
    expect(detectPlatform("BV1T6PQzQErF")).toBe("bilibili");
    expect(detectPlatform("分享 https://v.douyin.com/Abc/。")).toBe("douyin");
    expect(detectPlatform("https://www.douyin.com.evil.com/video/1")).toBeUndefined();
    expect(detectPlatform("https://evil-douyin.com/video/1")).toBeUndefined();
    expect(detectPlatform("https://b23.tv/Abcd")).toBe("bilibili");
    expect(findAdapterForUrl(new URL("https://www.bilibili.com/video/BV1T6PQzQErF"))).toBe(bilibiliAdapter);
    expect(getVideoMetadataData).not.toHaveBeenCalled();
    expect(listPlatformAdapters()).toHaveLength(2);
    expect(Object.isFrozen(listPlatformAdapters())).toBe(true);
    expect(getAdapter("douyin").platform).toBe("douyin");
  });
  it.each([undefined, "2"])("resolves BV/%s with the chosen part duration", async (page) => {
    vi.mocked(getVideoMetadataData).mockResolvedValue({ bvid: "BV1T6PQzQErF", title: "title", author: "author", description: "", tags: [], stats: {}, duration: 999,
      pages: [{ page: 1, cid: 1, title: "part 1", duration: 12 }, { page: 2, cid: 2, title: "part 2", duration: 34 }] });
    const source = await resolveVideoSource(page ? `https://www.bilibili.com/video/BV1T6PQzQErF?p=${page}` : "BV1T6PQzQErF");
    expect(source).toMatchObject({ videoId: "BV1T6PQzQErF", page: page ? 2 : 1, durationSeconds: page ? 34 : 12 });
  });
  it("rejects invalid pages, unsupported URLs and aborted operations before network", async () => {
    await expect(resolveVideoSource("https://www.bilibili.com/video/BV1T6PQzQErF?p=-1")).rejects.toMatchObject({ code: "PLATFORM_URL_INVALID" });
    await expect(resolveVideoSource("https://example.com/video/1")).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    await expect(resolveVideoSource("BV1T6PQzQErF", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(getVideoMetadataData).not.toHaveBeenCalled();
  });
});
