import { describe, expect, it } from "vitest";
import { formatVideoTranscript } from "../src/server/video-transcript.js";
import type { VideoSource } from "../src/platforms/types.js";

const source: VideoSource = {
  platform: "douyin", videoId: "7123456789012345678",
  canonicalUrl: "https://www.douyin.com/video/7123456789012345678",
  title: "示例视频", durationSeconds: 12,
};
const asr = { language: "zh", segments: [
  { from: 0, to: 3, content: "开始介绍" },
  { from: 3, to: 6, content: "核心观点" },
  { from: 6, to: 9, content: "解释例子" },
  { from: 9, to: 12, content: "核心回顾" },
] };

describe("cross-platform ASR transcript formatting", () => {
  it("preserves source identity and identifies ASR without inventing a BVID", () => {
    const payload = formatVideoTranscript(source, asr, { includeTimestamps: true });
    expect(payload).toMatchObject({ platform: "douyin", video_id: source.videoId, data_source: "asr", language: "zh" });
    expect(payload).not.toHaveProperty("bvid");
    expect(payload.transcript).toContain("[00:00:03 --> 00:00:06] 核心观点");
  });
  it("filters by overlapping time ranges using original segment timestamps", () => {
    const payload = formatVideoTranscript(source, asr, { startSeconds: 4, endSeconds: 5 });
    expect(payload.transcript).toBe("核心观点");
  });
  it("returns keyword matches with context and an honest canonical source link", () => {
    const payload = formatVideoTranscript(source, asr, { query: "核心", maxMatches: 1, contextSegments: 1 });
    expect(payload).toMatchObject({ total_matches: 2, returned_matches: 1, truncated: true });
    const matches = payload.matches as Array<Record<string, unknown>>;
    expect(matches[0]).toMatchObject({ start_seconds: 3, end_seconds: 6, timestamp_url: source.canonicalUrl });
    expect(matches[0].context).toContain("开始介绍");
    expect(matches[0].context).toContain("解释例子");
    expect(payload.transcript).not.toContain("核心回顾");
  });
  it("handles an empty recognition result without substituting the title", () => {
    expect(formatVideoTranscript(source, { segments: [] })).toMatchObject({ transcript: "", data_source: "asr" });
    expect(formatVideoTranscript(source, asr, { query: "absent" })).toMatchObject({ transcript: "", total_matches: 0 });
  });
  it("bounds keyword search even when context contains long ASR segments", () => {
    const large = { segments: Array.from({ length: 80 }, (_, index) => ({
      from: index, to: index + 1, content: "关键词" + "示例".repeat(1500),
    })) };
    const payload = formatVideoTranscript(source, large, { query: "关键词", maxMatches: 50, contextSegments: 5 });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(512 * 1024);
    expect(payload.truncated).toBe(true);
  });
});
