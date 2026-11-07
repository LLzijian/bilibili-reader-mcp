import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  extractKeyframes, hashGrayscaleFrame, KEYFRAME_LIMITS, selectKeyframeCandidates, validateKeyframeOptions,
} from "../src/media/keyframes.js";
import * as ffmpeg from "../src/media/ffmpeg.js";
import * as temp from "../src/media/temp.js";
import { FfmpegUnavailableError, KeyframeError } from "../src/utils/errors.js";
import { runWithOperationSignal } from "../src/security/operation-context.js";
import type { MediaAsset } from "../src/media/types.js";

const asset = (videoPath = path.resolve("synthetic.mp4"), durationSeconds = 6): MediaAsset => ({
  source: { platform: "bilibili", videoId: "synthetic", canonicalUrl: "https://www.bilibili.com/video/synthetic", title: "Synthetic", durationSeconds },
  videoPath, durationSeconds, hasVideo: true, hasAudio: false, sizeBytes: 100,
});
const candidate = (timestampSeconds: number, scene = false, hash = 0n, average = 80) => ({ timestampSeconds, scene, hash, average });
afterEach(() => vi.restoreAllMocks());

describe("keyframe validation and pure selection", () => {
  it("fills defaults and freezes exact resource limits", () => {
    expect(validateKeyframeOptions(undefined)).toEqual({ maxFrames: 6, strategy: "balanced" });
    expect(validateKeyframeOptions({ maxFrames: 12, strategy: "scene-change" })).toEqual({ maxFrames: 12, strategy: "scene-change" });
    expect(KEYFRAME_LIMITS).toEqual({ minFrames: 1, maxFrames: 12, defaultFrames: 6, maxCandidates: 120, maxDurationSeconds: 7200 });
    expect(Object.isFrozen(KEYFRAME_LIMITS)).toBe(true);
  });
  it.each([null, [], 1, { maxFrames: 0 }, { maxFrames: 13 }, { maxFrames: 1.2 }, { maxFrames: NaN }, { maxFrames: "6" }, { strategy: "ocr" }, { command: "ffmpeg" }])("rejects malformed options %j", (raw) => {
    expect(() => validateKeyframeOptions(raw)).toThrow();
  });
  it("computes deterministic dHash and distinguishes flat luminance", () => {
    const flat = hashGrayscaleFrame(Buffer.alloc(72, 80));
    expect(flat).toEqual({ hash: 0n, average: 80 });
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => 200 - i % 9);
    expect(hashGrayscaleFrame(ramp).hash).toBe((1n << 64n) - 1n);
    expect(hashGrayscaleFrame(Buffer.alloc(72, 160)).average).toBe(160);
    expect(() => hashGrayscaleFrame(Buffer.alloc(71))).toThrow();
  });
  it("retains distant repeats and covers the whole static timeline", () => {
    const selected = selectKeyframeCandidates(Array.from({ length: 24 }, (_, i) => candidate(i * 0.25)), 6, 6, "balanced");
    expect(selected).toHaveLength(6);
    expect(selected.map((c) => Math.floor(c.timestampSeconds))).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("penalizes nearby repeated pictures when a distinct alternative exists", () => {
    const selected = selectKeyframeCandidates([
      candidate(0.9), candidate(1.05, true), candidate(1.7, false, 0xffffffffffffffffn),
    ], 2, 2, "balanced");
    expect(selected.map((c) => c.timestampSeconds)).toEqual([0.9, 1.7]);
  });
  it("adds scene gain but keeps front/middle/end coverage in either strategy", () => {
    const candidates = [candidate(0.5), candidate(1.5), candidate(2.1, true), candidate(2.5), candidate(4.5), candidate(5.5)];
    for (const strategy of ["balanced", "scene-change"] as const) {
      const selected = selectKeyframeCandidates(candidates, 6, 3, strategy);
      expect(selected).toHaveLength(3);
      expect(selected[0].timestampSeconds).toBeLessThan(2);
      expect(selected[1].timestampSeconds).toBe(2.1);
      expect(selected[2].timestampSeconds).toBeGreaterThanOrEqual(4);
    }
    expect(selectKeyframeCandidates(candidates, 6, 3, "uniform")[1].scene).toBe(false);
  });
});

describe("keyframe guarded execution", () => {
  it("rejects no-video, invalid duration and nonlocal paths before running processes", async () => {
    const run = vi.spyOn(ffmpeg, "runFfmpeg");
    await expect(extractKeyframes({ ...asset(), hasVideo: false }, { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_NO_VIDEO" });
    for (const duration of [0, NaN, Infinity, 7201]) {
      await expect(extractKeyframes(asset(undefined, duration), { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_LIMIT_EXCEEDED" });
    }
    await expect(extractKeyframes(asset("https://example.invalid/video"), { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_FAILED" });
    expect(run).not.toHaveBeenCalled();
  });
  it("validates the probed track and duration instead of trusting asset metadata", async () => {
    const probe = vi.spyOn(ffmpeg, "probeMediaFile");
    probe.mockResolvedValueOnce({ durationSeconds: 6, sizeBytes: 1, streams: [{ type: "audio" }] });
    await expect(extractKeyframes(asset(), { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_NO_VIDEO" });
    probe.mockResolvedValueOnce({ durationSeconds: 7201, sizeBytes: 1, streams: [{ type: "video" }] });
    await expect(extractKeyframes(asset(), { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_LIMIT_EXCEEDED" });
  });
  it("preserves pre-abort including operation-context signals", async () => {
    const controller = new AbortController(); controller.abort();
    const probe = vi.spyOn(ffmpeg, "probeMediaFile");
    await expect(extractKeyframes(asset(), { maxFrames: 6 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(runWithOperationSignal(controller.signal, () => extractKeyframes(asset(), { maxFrames: 6 }))).rejects.toMatchObject({ name: "AbortError" });
    expect(probe).not.toHaveBeenCalled();
  });
  it("preserves missing ffmpeg errors", async () => {
    vi.spyOn(ffmpeg, "probeMediaFile").mockRejectedValue(new FfmpegUnavailableError());
    await expect(extractKeyframes(asset(), { maxFrames: 6 })).rejects.toBeInstanceOf(FfmpegUnavailableError);
  });
  it("bounds concurrent operations and releases slots after probe failure", async () => {
    let fail!: (error: Error) => void;
    vi.spyOn(ffmpeg, "probeMediaFile").mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const first = extractKeyframes(asset(), { maxFrames: 1 });
    const rejectFirst = expect(first).rejects.toBeInstanceOf(KeyframeError);
    const failFirst = fail;
    const second = extractKeyframes(asset(), { maxFrames: 1 });
    const rejectSecond = expect(second).rejects.toBeInstanceOf(KeyframeError);
    await expect(extractKeyframes(asset(), { maxFrames: 1 })).rejects.toMatchObject({ code: "KEYFRAME_LIMIT_EXCEEDED", retryable: true });
    failFirst(new Error("probe failure")); fail(new Error("probe failure"));
    await Promise.all([rejectFirst, rejectSecond]);
  });
  it.each(["failure", "cancel", "oversize", "timeout"])("cleans all temporary resources after %s", async (mode) => {
    vi.spyOn(ffmpeg, "probeMediaFile").mockResolvedValue({ durationSeconds: 6, sizeBytes: 1, streams: [{ type: "video" }] });
    const created = vi.spyOn(temp, "createMediaTempDir");
    const controller = new AbortController();
    vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (args, options) => {
      expect(args).toContain("file,pipe");
      expect(options?.timeoutMs).toBeLessThanOrEqual(90_000);
      expect(options?.signal).toBeDefined();
      const dir = await created.mock.results[0].value;
      await fs.writeFile(path.join(dir, "partial"), "partial");
      if (mode === "cancel") { controller.abort(); throw new DOMException("aborted", "AbortError"); }
      if (mode === "oversize") {
        const output = args[args.length - 1];
        await fs.writeFile(output, Buffer.alloc(73));
        return { stderr: "pts_time:0" };
      }
      throw new Error(mode === "timeout" ? "Media process timed out." : "failed");
    });
    const result = extractKeyframes(asset(), { maxFrames: 6, strategy: "uniform" }, controller.signal);
    await expect(result).rejects.toMatchObject(mode === "cancel" ? { name: "AbortError" } : { code: mode === "oversize" ? "KEYFRAME_LIMIT_EXCEEDED" : "KEYFRAME_FAILED" });
    const dir = await created.mock.results[0].value;
    expect(temp.isRegisteredMediaTempDir(dir)).toBe(false);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([false, true])("retries JPEG encoding within the stricter byte budget (always oversized=%s)", async (alwaysOversized) => {
    vi.spyOn(ffmpeg, "probeMediaFile").mockResolvedValue({ durationSeconds: 0.04, sizeBytes: 1, streams: [{ type: "video" }] });
    const created = vi.spyOn(temp, "createMediaTempDir");
    let jpegAttempts = 0;
    vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (args) => {
      const file = args[args.length - 1];
      if (file.endsWith(".raw")) await fs.writeFile(file, Buffer.alloc(72));
      else {
        jpegAttempts++;
        await fs.writeFile(file, alwaysOversized || jpegAttempts === 1 ? Buffer.alloc(192 * 1024 + 1) : Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      return { stderr: "pts_time:0" };
    });
    const result = extractKeyframes(asset(undefined, 0.04), { maxFrames: 1, strategy: "uniform" });
    if (alwaysOversized) {
      await expect(result).rejects.toMatchObject({ code: "KEYFRAME_LIMIT_EXCEEDED" });
      expect(jpegAttempts).toBe(4);
    } else {
      expect(await result).toHaveLength(1);
      expect(jpegAttempts).toBe(2);
    }
    const dir = await created.mock.results[0].value;
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces the overall operation deadline and releases the concurrency slot", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(ffmpeg, "probeMediaFile").mockImplementation((_file, signal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
      const result = extractKeyframes(asset(), { maxFrames: 1 });
      const rejected = expect(result).rejects.toMatchObject({ code: "KEYFRAME_FAILED", retryable: true });
      await vi.advanceTimersByTimeAsync(180_000);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
  it("caps candidates and scene logs, and cleans successful extraction", async () => {
    vi.spyOn(ffmpeg, "probeMediaFile").mockResolvedValue({ durationSeconds: 7200, sizeBytes: 1, streams: [{ type: "video" }] });
    const created = vi.spyOn(temp, "createMediaTempDir");
    let grayscale = 0;
    vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (args, options) => {
      const output = args[args.length - 1];
      if (output === "-") {
        expect(options?.maxStderrBytes).toBe(96 * 1024);
        expect(args[args.indexOf("-frames:v") + 1]).toBe("72");
        return { stderr: Array.from({ length: 200 }, (_, i) => `pts_time:${i * 60}`).join("\n") };
      }
      if (output.endsWith(".raw")) { grayscale++; await fs.writeFile(output, Buffer.alloc(72, 80)); }
      else await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return { stderr: "pts_time:0" };
    });
    expect(await extractKeyframes(asset(undefined, 7200), { maxFrames: 12 })).toHaveLength(12);
    expect(grayscale).toBeLessThanOrEqual(120);
    const dir = await created.mock.results[0].value;
    expect(temp.isRegisteredMediaTempDir(dir)).toBe(false);
  }, 30_000);
});

const available = [ffmpeg.resolveFfmpegPath(), ffmpeg.resolveFfprobePath()].every((executable) =>
  spawnSync(executable, ["-version"], { windowsHide: true, timeout: 10_000, stdio: "ignore" }).status === 0);

describe.skipIf(!available)("actual ffmpeg synthetic videos", () => {
  let dir: string;
  const makeVideo = async (name: string, args: string[]) => {
    const file = path.join(dir, name);
    await ffmpeg.runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...args, file], { timeoutMs: 30_000 });
    return file;
  };
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "keyframes-test-")); });
  afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

  function jpegDimensions(image: Buffer): [number, number] {
    let pos = 2;
    while (pos + 9 < image.length) {
      const marker = image[pos + 1];
      if (marker >= 0xc0 && marker <= 0xc3) return [image.readUInt16BE(pos + 7), image.readUInt16BE(pos + 5)];
      pos += 2 + image.readUInt16BE(pos + 2);
    }
    throw new Error("No JPEG dimensions");
  }
  const verify = (frames: Awaited<ReturnType<typeof extractKeyframes>>, duration: number) => {
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(12);
    for (const frame of frames) {
      expect(frame.timestampSeconds).toBeGreaterThanOrEqual(0);
      expect(frame.timestampSeconds).toBeLessThan(duration);
      expect(frame.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frame.image.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      expect(frame.image.length).toBeLessThanOrEqual(192 * 1024);
      expect(jpegDimensions(frame.image)[0]).toBeLessThanOrEqual(1280);
    }
    expect(frames.map((f) => f.timestampSeconds)).toEqual(frames.map((f) => f.timestampSeconds).sort((a, b) => a - b));
  };

  it("keeps six static frames spread through the timeline", async () => {
    const file = await makeVideo("static.mp4", ["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=12:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const created = vi.spyOn(temp, "createMediaTempDir");
    const frames = await extractKeyframes(asset(file), validateKeyframeOptions({}));
    verify(frames, 6);
    expect(frames).toHaveLength(6);
    expect(frames[0].timestampSeconds).toBeLessThan(1);
    expect(frames.at(-1)!.timestampSeconds).toBeGreaterThan(5);
    expect(frames.map((f) => Math.floor(f.timestampSeconds))).toEqual([0, 1, 2, 3, 4, 5]);
    const extractedDir = await created.mock.results[0].value;
    await expect(fs.stat(extractedDir)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it.each(["balanced", "scene-change"] as const)("uses scene changes and covers front/middle/end with %s", async (strategy) => {
    const file = await makeVideo(`scenes-${strategy}.mp4`, [
      "-f", "lavfi", "-i", "color=c=black:s=320x180:r=12:d=2",
      "-f", "lavfi", "-i", "color=c=white:s=320x180:r=12:d=2",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:r=12:d=2",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]);
    const frames = await extractKeyframes(asset(file), { maxFrames: 3, strategy });
    verify(frames, 6);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => Math.floor(f.timestampSeconds / 2))).toEqual([0, 1, 2]);
    expect(frames.filter((f) => f.reason?.startsWith("Scene change")).length).toBeGreaterThan(0);
    // Decode returned JPEGs themselves: their luminance must agree with the reported time segment.
    for (const [index, frame] of frames.entries()) {
      const jpg = path.join(dir, `${strategy}-${index}.jpg`);
      const raw = path.join(dir, `${strategy}-${index}.raw`);
      await fs.writeFile(jpg, frame.image);
      await ffmpeg.runFfmpeg(["-y", "-protocol_whitelist", "file,pipe", "-i", jpg, "-vf", "scale=9:8,format=gray", "-frames:v", "1", "-f", "rawvideo", raw]);
      const { average } = hashGrayscaleFrame(await fs.readFile(raw));
      if (frame.timestampSeconds < 2) expect(average).toBeLessThan(10);
      else if (frame.timestampSeconds < 4) expect(average).toBeGreaterThan(240);
      else { expect(average).toBeGreaterThan(40); expect(average).toBeLessThan(120); }
    }
  }, 60_000);

  it("handles one real presentation frame in an extremely short video", async () => {
    const file = await makeVideo("short.mp4", ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=25:d=0.04", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const frames = await extractKeyframes(asset(file, 0.04), { maxFrames: 12 });
    verify(frames, 0.04);
    expect(frames).toHaveLength(1);
    expect(frames[0].timestampSeconds).toBe(0);
  }, 30_000);

  it("handles low-fps EOF seeks without losing all available frames", async () => {
    const file = await makeVideo("low-fps.mp4", ["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=1:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    verify(await extractKeyframes(asset(file, 2), { maxFrames: 6, strategy: "uniform" }), 2);
  }, 30_000);

  it("enforces JPEG byte and width limits for detailed large images", async () => {
    const file = await makeVideo("detail.mp4", ["-f", "lavfi", "-i", "testsrc2=s=2560x1440:r=4:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
    verify(await extractKeyframes(asset(file, 1), { maxFrames: 1, strategy: "uniform" }), 1);
  }, 30_000);

  it("kills a running ffmpeg operation on cancellation and removes partial resources", async () => {
    const file = await makeVideo("cancel.mp4", ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=6", "-c:v", "libx264", "-preset", "ultrafast"]);
    const created = vi.spyOn(temp, "createMediaTempDir");
    const originalRun = ffmpeg.runFfmpeg;
    const controller = new AbortController();
    let started = false;
    vi.spyOn(ffmpeg, "runFfmpeg").mockImplementation(async (args, options) => {
      started = true;
      const pending = originalRun(args, options);
      const timer = setTimeout(() => controller.abort(), 20);
      try { return await pending; } finally { clearTimeout(timer); }
    });
    await expect(extractKeyframes(asset(file), { maxFrames: 6 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(true);
    const extractedDir = await created.mock.results[0].value;
    await expect(fs.stat(extractedDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(file)).isFile()).toBe(true);
  }, 30_000);

  it("rejects an actual audio-only file", async () => {
    const file = await makeVideo("audio.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac"]);
    await expect(extractKeyframes(asset(file, 1), { maxFrames: 6 })).rejects.toMatchObject({ code: "KEYFRAME_NO_VIDEO" });
  });
});
