import { describe, expect, it } from "vitest";
import { canHandleDouyinUrl, canonicalDouyinUrl, douyinVideoId, parseDouyinInput } from "../src/douyin/url.js";
import { DOUYIN_ID } from "./fixtures/douyin.js";
describe("Douyin video URLs", () => {
  it("preserves a 64-bit ID as a string", () => {
    const url = parseDouyinInput(`分享（https://www.douyin.com/video/${DOUYIN_ID}?tracking=x）。`);
    expect(douyinVideoId(url)).toBe(DOUYIN_ID);
    expect(canonicalDouyinUrl(DOUYIN_ID)).toBe(`https://www.douyin.com/video/${DOUYIN_ID}`);
    expect(douyinVideoId(new URL(`https://www.iesdouyin.com/share/video/${DOUYIN_ID}/`))).toBe(DOUYIN_ID);
    expect(canHandleDouyinUrl(new URL("https://v.douyin.com/Abc-123/"))).toBe(true);
  });
  it.each(["https://douyin.com.evil.com/video/1", "https://evil-douyin.com/video/1", "https://sub.www.douyin.com/video/1", "https://www.douyin.com:444/video/1", "http://www.douyin.com/video/1", "https://name@www.douyin.com/video/1", "https://www.douyin.com/note/1", "https://v.douyin.com/", "https://www.douyin.com/video/1/extra"])("refuses %s", (raw) => {
    expect(canHandleDouyinUrl(new URL(raw))).toBe(false);
    expect(() => parseDouyinInput(raw)).toThrow(expect.objectContaining({ code: "PLATFORM_URL_INVALID" }));
  });
});
