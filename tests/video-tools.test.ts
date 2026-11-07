import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpHandler } from "./helpers/mcp.js";
import { MediaError } from "../src/utils/errors.js";

const mocks = vi.hoisted(() => ({ keyframes: vi.fn(), clips: vi.fn(), transcript: vi.fn(), frames: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/server/video-services.js", () => ({
  readVideoKeyframes: mocks.keyframes, createVideoClips: mocks.clips,
  readDouyinTranscript: mocks.transcript, readDouyinFrames: mocks.frames,
}));
vi.mock("../src/platforms/registry.js", async (original) => ({
  ...await original<typeof import("../src/platforms/registry.js")>(), resolveVideoSource: mocks.resolve,
}));
const url = "https://www.douyin.com/video/7123456789012345678";
const call = (name: string, args: unknown, signal?: AbortSignal) =>
  getMcpHandler<any, any>("tools/call")({ jsonrpc: "2.0", method: "tools/call", id: 1, params: { name, arguments: args } }, { signal });
beforeEach(() => vi.clearAllMocks());

describe("cross-platform video MCP tools", () => {
  it("keeps existing tools and registers both new tools", async () => {
    const result = await getMcpHandler<any, any>("tools/list")({ method: "tools/list" });
    expect(result.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      "get_video_metadata", "get_video_transcript", "get_video_frames", "get_video_chapters",
      "get_video_keyframes", "extract_video_clips",
    ]));
  });
  it("returns actual keyframe image content and forwards cancellation", async () => {
    const image = { content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" }] };
    mocks.keyframes.mockResolvedValueOnce(image);
    const controller = new AbortController();
    expect(await call("get_video_keyframes", { url }, controller.signal)).toEqual(image);
    expect(mocks.keyframes).toHaveBeenCalledWith(url, { maxFrames: 6, strategy: "balanced" }, controller.signal);
  });
  it.each([
    { url, max_frames: 0 }, { url, max_frames: 13 }, { url, max_frames: 1.5 },
    { url, strategy: "ocr" }, { url, output_path: "C:/output" }, { url, cookie: "secret" },
  ])("rejects unsafe keyframe arguments before processing %#", async (args) => {
    expect((await call("get_video_keyframes", args)).isError).toBe(true);
    expect(mocks.keyframes).not.toHaveBeenCalled();
  });
  it("converts public clip fields without accepting output paths", async () => {
    mocks.clips.mockResolvedValueOnce({ platform: "douyin", clips: [{ file_path: "server-generated.mp4" }] });
    const controller = new AbortController();
    const result = await call("extract_video_clips", { url, clips: [{ start_seconds: 1, end_seconds: 3, label: "演示" }] }, controller.signal);
    expect(result.structuredContent.clips[0].file_path).toBe("server-generated.mp4");
    expect(mocks.clips).toHaveBeenCalledWith(url, [{ startSeconds: 1, endSeconds: 3, label: "演示" }], controller.signal);
  });
  it.each([
    [], [{ start_seconds: -1, end_seconds: 2 }], [{ start_seconds: 3, end_seconds: 2 }],
    [{ start_seconds: 0, end_seconds: 181 }], [{ start_seconds: 0, end_seconds: NaN }],
    Array.from({ length: 6 }, () => ({ start_seconds: 0, end_seconds: 2 })),
    Array.from({ length: 4 }, () => ({ start_seconds: 0, end_seconds: 180 })),
    [{ start_seconds: 0, end_seconds: 2, label: "../../evil" }],
    [{ start_seconds: 0, end_seconds: 2, output_path: "evil.mp4" }],
  ])("validates clip ranges before processing %#", async (clips) => {
    expect((await call("extract_video_clips", { url, clips })).isError).toBe(true);
    expect(mocks.clips).not.toHaveBeenCalled();
  });
  it("reads Douyin metadata without downloading media", async () => {
    mocks.resolve.mockResolvedValueOnce({ platform: "douyin", videoId: "7123456789012345678", canonicalUrl: url, title: "测试", durationSeconds: 10 });
    const result = await call("get_video_metadata", { bvid_or_url: url });
    expect(result.structuredContent).toMatchObject({ platform: "douyin", video_id: "7123456789012345678", duration_seconds: 10 });
    expect(mocks.transcript).not.toHaveBeenCalled();
  });
  it("requires explicit local transcription permission for Douyin", async () => {
    const result = await call("get_video_transcript", { bvid_or_url: url, fallback_to_description: true });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text);
    expect(error.code).toBe("SUBTITLE_UNAVAILABLE");
    expect(error.next_steps.join(" ")).toContain("fallback_to_asr");
    expect(error.next_steps.join(" ")).not.toContain("Bilibili Cookie");
    expect(mocks.transcript).not.toHaveBeenCalled();
  });
  it.each(["fallback_to_asr", "force_asr"])("honors explicit %s permission and filters", async (flag) => {
    mocks.transcript.mockResolvedValueOnce({ data_source: "asr", transcript: "测试" });
    const controller = new AbortController();
    const result = await call("get_video_transcript", { bvid_or_url: url, [flag]: true, include_timestamps: true, query: " 测试 " }, controller.signal);
    expect(result.structuredContent.data_source).toBe("asr");
    expect(mocks.transcript).toHaveBeenCalledWith(url, expect.objectContaining({ includeTimestamps: true, query: "测试" }), controller.signal);
  });
  it.each(["get_video_frames", "get_video_transcript"])("rejects Douyin page for %s", async (name) => {
    expect((await call(name, { bvid_or_url: url, page: 1, timestamps: [1] })).isError).toBe(true);
    expect(mocks.frames).not.toHaveBeenCalled();
    expect(mocks.transcript).not.toHaveBeenCalled();
  });
  it("routes explicit Douyin frames to the unified media pipeline", async () => {
    const images = { content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" }] };
    mocks.frames.mockResolvedValueOnce(images);
    expect(await call("get_video_frames", { bvid_or_url: url, timestamps: [1] })).toEqual(images);
  });
  it("maps media failures through stable structured errors without leaking messages", async () => {
    mocks.keyframes.mockRejectedValueOnce(new MediaError("MEDIA_DOWNLOAD_FAILED", "https://private.example/?signature=secret", true));
    const result = await call("get_video_keyframes", { url });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED", retryable: true });
    expect(JSON.stringify(result)).not.toContain("signature=secret");
  });
});
