import { describe, expect, it } from "vitest";
import { parseDouyinMediaCandidates } from "../src/douyin/playback.js";
import { validateDouyinMediaUrl } from "../src/douyin/http.js";
import { parseDouyinVideoPage } from "../src/douyin/metadata.js";
import { DOUYIN_ID, douyinItem, routerHtml } from "./fixtures/douyin.js";
function parse(video: Record<string, unknown>) {
  return parseDouyinMediaCandidates(parseDouyinVideoPage(routerHtml(douyinItem({ video: { duration: 1000, ...video } })), DOUYIN_ID));
}
const addr = (name: string) => ({ url_list: [`https://fixture.douyinvod.com/${name}.mp4`], width: 1280, height: 720 });
describe("Douyin media candidates", () => {
  it("prefers progressive MP4 and preserves validated representation facts", () => {
    const result = parse({ play_addr: addr("progressive"), bit_rate: [{ play_addr: addr("video") }], bit_rate_audio: [{ play_addr: addr("audio") }] });
    expect(result.progressive).toEqual([expect.objectContaining({ url: "https://fixture.douyinvod.com/progressive.mp4", mimeType: "video/mp4", width: 1280, height: 720 })]);
    expect(result.split).toBeUndefined();
    expect(Object.keys(result.requestHeaders!)).toEqual(["Referer", "User-Agent"]);
  });
  it("returns separate bitrate video and audio tracks", () => {
    const result = parse({ bit_rate: [{ play_addr: addr("video"), bit_rate: 1000 }], bit_rate_audio: [{ play_addr: addr("audio"), bit_rate: 128 }] });
    expect(result.progressive).toBeUndefined();
    expect(result.split?.video[0]).toMatchObject({ mimeType: "video/mp4", bandwidth: 1000 });
    expect(result.split?.audio?.[0]).toMatchObject({ mimeType: "audio/mp4", bandwidth: 128 });
  });
  it("parses the documented audio_meta URL object and rejects unsupported formats", () => {
    const result = parse({ bit_rate: [{ play_addr: addr("video") }], bit_rate_audio: [{ audio_meta: {
      bitrate: 128000, format: "mp4", url_list: { main_url: "https://fixture.douyinvod.com/audio.mp4", backup_url: "https://backup.douyinvod.com/audio.mp4" },
    } }] });
    expect(result.split?.audio).toHaveLength(2);
    expect(result.split?.audio?.[0]).toMatchObject({ bandwidth: 128000, mimeType: "audio/mp4" });
    expect(() => parse({ bit_rate: [{ play_addr: addr("video") }], bit_rate_audio: [{ audio_meta: { format: "mp3", url_list: { main_url: "https://fixture.douyinvod.com/audio.mp3" } } }] })).toThrow(expect.objectContaining({ code: "DOUYIN_MEDIA_UNAVAILABLE" }));
  });
  it("supports progressive bitrate alternatives without inventing missing audio", () => {
    expect(parse({ bit_rate: [{ play_addr: addr("muxed") }] }).progressive).toHaveLength(1);
    expect(() => parse({ bit_rate: [{ play_addr: addr("video") }], bit_rate_audio: [{ play_addr: { url_list: ["https://evil.com/audio"] } }] })).toThrow(expect.objectContaining({ code: "DOUYIN_MEDIA_UNAVAILABLE" }));
  });
  it("bounds progressive and split candidates to eight", () => {
    expect(parse({ play_addr: { url_list: Array.from({ length: 20 }, (_, i) => `https://fixture.douyinvod.com/${i}.mp4`) } }).progressive).toHaveLength(8);
    const split = parse({ bit_rate: Array.from({ length: 20 }, (_, i) => ({ play_addr: addr(`video${i}`) })), bit_rate_audio: Array.from({ length: 20 }, (_, i) => ({ play_addr: addr(`audio${i}`) })) }).split!;
    expect(split.video.length + split.audio!.length).toBe(8);
  });
  it.each(["http://fixture.douyinvod.com/a.mp4", "https://user:pass@fixture.douyinvod.com/a.mp4", "https://fixture.douyinvod.com:444/a.mp4", "https://douyinvod.com.evil.com/a.mp4", "https://evil-douyinvod.com/a.mp4", "https://127.0.0.1/a.mp4", "https://www.douyin.com/a.mp4"])("rejects an unsupported CDN URL %s", (url) => {
    expect(() => validateDouyinMediaUrl(url)).toThrow(expect.objectContaining({ code: "DOUYIN_MEDIA_UNAVAILABLE" }));
    expect(() => parse({ play_addr: { url_list: [url] } })).toThrow(expect.objectContaining({ code: "DOUYIN_MEDIA_UNAVAILABLE" }));
  });
  it("does not substitute music previews for absent video media", () => expect(() => parse({ music: { play_url: addr("music") } })).toThrow(expect.objectContaining({ code: "DOUYIN_MEDIA_UNAVAILABLE" })));
});
