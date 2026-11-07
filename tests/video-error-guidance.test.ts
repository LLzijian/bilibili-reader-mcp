import { describe, expect, it } from "vitest";
import { buildStructuredErrorPayload } from "../src/utils/error-guidance.js";
import { ClipError, FfmpegUnavailableError, KeyframeError, MediaError, PlatformError } from "../src/utils/errors.js";

const secretMessage = "Cookie: sensitive-cookie https://cdn.example/video?signature=private-token";

describe("cross-platform video error guidance", () => {
  it.each([
    [new PlatformError("UNSUPPORTED_PLATFORM", secretMessage), "UNSUPPORTED_PLATFORM", "validation"],
    [new PlatformError("DOUYIN_ACCESS_DENIED", secretMessage), "DOUYIN_ACCESS_DENIED", "access"],
    [new PlatformError("DOUYIN_CHALLENGE_REQUIRED", secretMessage), "DOUYIN_CHALLENGE_REQUIRED", "access"],
    [new PlatformError("DOUYIN_MEDIA_UNAVAILABLE", secretMessage), "DOUYIN_MEDIA_UNAVAILABLE", "content"],
    [new MediaError("MEDIA_DOWNLOAD_TIMEOUT", secretMessage, true), "MEDIA_DOWNLOAD_TIMEOUT", "network"],
    [new MediaError("MEDIA_FAKE_IP_DNS", secretMessage), "MEDIA_FAKE_IP_DNS", "network"],
    [new MediaError("MEDIA_LIMIT_EXCEEDED", secretMessage), "MEDIA_LIMIT_EXCEEDED", "resource"],
    [new MediaError("MEDIA_NO_AUDIO_TRACK", secretMessage), "MEDIA_NO_AUDIO_TRACK", "content"],
    [new MediaError("MEDIA_PROBE_FAILED", secretMessage), "MEDIA_PROBE_FAILED", "runtime"],
    [new KeyframeError("KEYFRAME_NO_VIDEO", secretMessage), "KEYFRAME_NO_VIDEO", "content"],
    [new KeyframeError("KEYFRAME_FAILED", secretMessage), "KEYFRAME_FAILED", "runtime"],
    [new ClipError("CLIP_INVALID_RANGE", secretMessage), "CLIP_INVALID_RANGE", "validation"],
    [new ClipError("CLIP_LIMIT_EXCEEDED", secretMessage), "CLIP_LIMIT_EXCEEDED", "resource"],
    [new ClipError("CLIP_FAILED", secretMessage), "CLIP_FAILED", "runtime"],
    [new FfmpegUnavailableError(secretMessage), "FFMPEG_UNAVAILABLE", "runtime"],
  ] as const)("maps %s to stable guidance", (error, code, category) => {
    const result = buildStructuredErrorPayload(error);
    expect(result).toMatchObject({ error: true, code, category });
    expect(result.message_en.length).toBeGreaterThan(0);
    expect(result.message_zh.length).toBeGreaterThan(0);
    expect(result.next_steps).toEqual(result.next_steps_en);
    expect(result.next_steps_en.length).toBeGreaterThan(0);
    expect(result.next_steps_zh.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sensitive-cookie");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("cdn.example");
  });

  it("preserves declared retryability and marks required user action", () => {
    expect(buildStructuredErrorPayload(new MediaError("MEDIA_DOWNLOAD_FAILED", secretMessage, true)))
      .toMatchObject({ retryable: true, user_action_required: false });
    expect(buildStructuredErrorPayload(new ClipError("CLIP_INVALID_RANGE", secretMessage)))
      .toMatchObject({ retryable: false, user_action_required: true });
  });
});
