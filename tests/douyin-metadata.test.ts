import { describe, expect, it, vi } from "vitest";
import { DOUYIN_JSON_LIMITS, loadDouyinVideo, parseDouyinVideoPage } from "../src/douyin/metadata.js";
import { MAX_DOUYIN_HTML_BYTES } from "../src/douyin/http.js";
import { DOUYIN_ID, douyinItem, renderHtml, routerHtml } from "./fixtures/douyin.js";
describe("bounded Douyin page metadata", () => {
  it.each([routerHtml, renderHtml])("parses synthetic embedded data without losing ID precision", (html) => {
    const video = parseDouyinVideoPage(html(), DOUYIN_ID);
    expect(video.source).toMatchObject({ videoId: DOUYIN_ID, title: "合成视频标题", author: "测试作者", durationSeconds: 12.5 });
    expect(video.source.canonicalUrl).toBe(`https://www.douyin.com/video/${DOUYIN_ID}`);
  });
  it("respects quoted braces and escape characters", () => {
    expect(parseDouyinVideoPage(routerHtml(douyinItem({ desc: '括号 } { \\" 与 captcha 说明' })), DOUYIN_ID).source.title).toContain("captcha");
  });
  it.each([
    ["images", { images: [{ url: "synthetic" }] }, "DOUYIN_VIDEO_UNAVAILABLE"],
    ["image type", { aweme_type: 68 }, "DOUYIN_VIDEO_UNAVAILABLE"],
    ["live", { live_room: { id: "synthetic" } }, "DOUYIN_VIDEO_UNAVAILABLE"],
    ["removed", { status: { is_delete: true } }, "DOUYIN_VIDEO_UNAVAILABLE"],
    ["private", { status: { private_status: 1 } }, "DOUYIN_ACCESS_DENIED"],
    ["ads", { is_ads: true }, "DOUYIN_VIDEO_UNAVAILABLE"],
  ])("rejects %s with a structured error", (_name, extra, code) => {
    expect(() => parseDouyinVideoPage(routerHtml(douyinItem(extra as Record<string, unknown>)), DOUYIN_ID)).toThrow(expect.objectContaining({ code }));
  });
  it.each(["<script>window._ROUTER_DATA = {broken};</script>", '<script id="RENDER_DATA">%broken</script>', '<script id="RENDER_DATA">%7B%7D</script>'])
    ("maps malformed/missing data to platform errors", (html) => expect(() => parseDouyinVideoPage(html, DOUYIN_ID)).toThrow(expect.objectContaining({ code: "PLATFORM_RESOLVE_FAILED" })));
  it.each([{ desc: "" }, { video: {} }, { video: { duration: -1 } }, { aweme_id: 9999999999999999999 }])("refuses missing facts or numeric IDs", (extra) => {
    expect(() => parseDouyinVideoPage(routerHtml(douyinItem(extra)), DOUYIN_ID)).toThrow(expect.objectContaining({ code: "PLATFORM_RESOLVE_FAILED" }));
  });
  it.each([
    ["captcha 安全验证", "DOUYIN_CHALLENGE_REQUIRED"], ["请先登录", "DOUYIN_ACCESS_DENIED"],
    ["该视频已删除", "DOUYIN_VIDEO_UNAVAILABLE"], ["私密视频", "DOUYIN_ACCESS_DENIED"],
  ])("classifies page wall %s", (html, code) => expect(() => parseDouyinVideoPage(html, DOUYIN_ID)).toThrow(expect.objectContaining({ code })));
  it("enforces HTML, depth, string, node and array budgets", () => {
    const oversized = "a".repeat(MAX_DOUYIN_HTML_BYTES + 1);
    const deeplyNested = `<script>window._ROUTER_DATA=${"[".repeat(40)}{}${"]".repeat(40)}</script>`;
    const hugeString = routerHtml(douyinItem({ desc: "a".repeat(DOUYIN_JSON_LIMITS.string + 1) }));
    const hugeArray = routerHtml({ items: Array(257).fill(0) });
    const hugeNodes = routerHtml({ items: Array.from({ length: 250 }, () => Array(100).fill(null)) });
    for (const html of [oversized, deeplyNested, hugeString, hugeArray, hugeNodes]) expect(() => parseDouyinVideoPage(html, DOUYIN_ID)).toThrow(expect.objectContaining({ code: "PLATFORM_RESOLVE_FAILED" }));
  });
  it("omits unsafe cover URLs and bounds sanitized remote fields", () => {
    const parsed = parseDouyinVideoPage(routerHtml(douyinItem({ desc: "中".repeat(1000), author: { nickname: "作".repeat(200) }, video: { duration: 1000, cover: { url_list: ["http://127.0.0.1/cover"] } } })), DOUYIN_ID);
    expect(Buffer.byteLength(parsed.source.title)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(parsed.source.author!)).toBeLessThanOrEqual(128);
    expect(parsed.source.coverUrl).toBeUndefined();
  });
  it("expands short links and reads only the requested public share page", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ url: new URL(`https://www.douyin.com/video/${DOUYIN_ID}`), html: "" })
      .mockResolvedValueOnce({ url: new URL(`https://www.iesdouyin.com/share/video/${DOUYIN_ID}/`), html: routerHtml() });
    expect((await loadDouyinVideo("分享：https://v.douyin.com/synthetic/。", undefined, { fetchPage })).source.videoId).toBe(DOUYIN_ID);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it("rejects a mismatched requested video and honors cancellation", async () => {
    const fetchPage = vi.fn(async () => ({ url: new URL("https://www.iesdouyin.com/share/video/123/"), html: routerHtml() }));
    await expect(loadDouyinVideo(`https://www.douyin.com/video/${DOUYIN_ID}`, undefined, { fetchPage })).rejects.toMatchObject({ code: "PLATFORM_RESOLVE_FAILED" });
    fetchPage.mockClear();
    await expect(loadDouyinVideo(`https://www.douyin.com/video/${DOUYIN_ID}`, AbortSignal.abort(), { fetchPage })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
