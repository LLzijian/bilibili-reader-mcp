import { describe, expect, it, vi } from "vitest";
import { createDouyinAdapter } from "../src/douyin/adapter.js";
import { DOUYIN_ID, routerHtml } from "./fixtures/douyin.js";
describe("Douyin adapter contract", () => {
  it("exposes metadata and bounded candidates through frozen interfaces", async () => {
    const fetchPage = vi.fn(async () => ({ url: new URL(`https://www.iesdouyin.com/share/video/${DOUYIN_ID}/`), html: routerHtml() }));
    const adapter = createDouyinAdapter({ fetchPage });
    const source = await adapter.resolve(`https://www.douyin.com/video/${DOUYIN_ID}?tracking=removed`);
    expect(source.videoId).toBe(DOUYIN_ID);
    expect(source.canonicalUrl).not.toContain("tracking");
    const controller = new AbortController();
    const media = await adapter.getMediaCandidates(source, controller.signal);
    expect(media.progressive?.[0].mimeType).toBe("video/mp4");
    expect(fetchPage).toHaveBeenLastCalledWith(`https://www.iesdouyin.com/share/video/${DOUYIN_ID}/`, controller.signal);
    expect(media.requestHeaders).not.toHaveProperty("Cookie");
  });
  it("propagates cancellation after page fetch and validates platform identity", async () => {
    const controller = new AbortController();
    const adapter = createDouyinAdapter({ fetchPage: async () => {
      controller.abort();
      return { url: new URL(`https://www.iesdouyin.com/share/video/${DOUYIN_ID}/`), html: routerHtml() };
    } });
    await expect(adapter.resolve(`https://www.douyin.com/video/${DOUYIN_ID}`, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.getMediaCandidates({ platform: "bilibili", videoId: DOUYIN_ID, title: "synthetic", canonicalUrl: "https://example.com/", durationSeconds: 1 })).rejects.toMatchObject({ code: "PLATFORM_URL_INVALID" });
  });
});
