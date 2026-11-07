import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { MediaAsset } from "../src/media/types.js";
import type { ProbeResult } from "../src/media/ffmpeg.js";
import { FfmpegUnavailableError } from "../src/utils/errors.js";

const state = vi.hoisted(() => ({ config: "", run: vi.fn(), probe: vi.fn() }));
vi.mock("../src/utils/credentials.js", () => ({ get GLOBAL_CONFIG_DIR() { return state.config; } }));
vi.mock("../src/media/ffmpeg.js", () => ({ runFfmpeg: state.run, probeMediaFile: state.probe }));
import { CLIP_LIMITS, validateClipRanges, extractVideoClips, resolveClipsDirectory } from "../src/media/clips.js";
import { runWithOperationSignal } from "../src/security/operation-context.js";

let root: string;
let asset: MediaAsset;
let audio: boolean;
const encoded = new Map<string, number>();
function probe(duration = 10, hasAudio = true): ProbeResult {
  return { durationSeconds: duration, sizeBytes: 1024, formatName: "mov,mp4,m4a,3gp,3g2,mj2", streams: [
    { type: "video", codecName: "h264", width: 320, height: 240 },
    ...(hasAudio ? [{ type: "audio" as const, codecName: "aac" }] : []),
  ] };
}
async function files(): Promise<string[]> {
  if (!existsSync(state.config)) return [];
  const walk = async (dir: string): Promise<string[]> => (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
  return walk(state.config);
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "video-clips-test-")));
  state.config = path.join(root, "config");
  const input = path.join(root, "source.mp4");
  await fs.writeFile(input, Buffer.alloc(1024));
  asset = { source: { platform: "douyin", videoId: "123", canonicalUrl: "https://www.douyin.com/video/123", title: "Synthetic", durationSeconds: 10 },
    videoPath: input, durationSeconds: 10, sizeBytes: 1024, hasVideo: true, hasAudio: true };
  audio = true;
  encoded.clear();
  state.run.mockImplementation(async (args: string[]) => {
    const output = args.at(-1)!;
    encoded.set(output, Number(args[args.indexOf("-t") + 1]));
    await fs.writeFile(output, Buffer.alloc(1024));
    return { stderr: "" };
  });
  state.probe.mockImplementation(async (filename: string) => probe(encoded.get(filename) ?? 10, audio));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("clip validation", () => {
  it("exposes frozen contract budgets and preserves overlapping ranges independently", () => {
    expect(Object.isFrozen(CLIP_LIMITS)).toBe(true);
    const ranges = [{ startSeconds: 0, endSeconds: 180 }, { startSeconds: 100, endSeconds: 280, label: "讲解" }];
    expect(validateClipRanges(ranges, 7200)).toEqual(ranges);
    expect(validateClipRanges([{ startSeconds: 0, endSeconds: 1, label: "a".repeat(80) }], 1)).toHaveLength(1);
    expect(validateClipRanges(Array.from({ length: 5 }, () => ({ startSeconds: 0, endSeconds: 120 })), 120)).toHaveLength(5);
  });
  it.each([undefined, null, {}, [], [null], [[]], [{ startSeconds: 0, endSeconds: "2" }],
    [{ startSeconds: NaN, endSeconds: 2 }], [{ startSeconds: 0, endSeconds: Infinity }],
    [{ startSeconds: -1, endSeconds: 2 }], [{ startSeconds: 2, endSeconds: 1 }],
    [{ startSeconds: 1, endSeconds: 1 }], [{ startSeconds: 0, endSeconds: 0.99 }],
    [{ startSeconds: 9, endSeconds: 11 }], [{ startSeconds: 0, endSeconds: 2, output_path: "x" }],
    Array.from({ length: 6 }, () => ({ startSeconds: 0, endSeconds: 2 }))])("rejects malformed ranges %#", raw => {
    expect(() => validateClipRanges(raw, 10)).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 7201])("rejects invalid source duration %s", duration => {
    expect(() => validateClipRanges([{ startSeconds: 0, endSeconds: 1 }], duration)).toThrow();
  });
  it("rejects per-clip and cumulative duration overflow", () => {
    expect(() => validateClipRanges([{ startSeconds: 0, endSeconds: 180.001 }], 1000)).toThrow();
    expect(() => validateClipRanges(Array.from({ length: 5 }, () => ({ startSeconds: 0, endSeconds: 121 })), 1000)).toThrow();
  });
  it.each(["../escape", "a/b", "a\\b", "C:\\evil", "C:evil", "/absolute", "\\\\server\\file", "a\0b", "x\ny", "a".repeat(81), 3])("rejects unsafe label %#", label => {
    expect(() => validateClipRanges([{ startSeconds: 0, endSeconds: 1, label }], 10)).toThrow();
  });
});

describe("persistent clips and cleanup", () => {
  it("returns independently encoded persistent files with random names and safe flags", async () => {
    const result = await extractVideoClips(asset, [{ startSeconds: 1, endSeconds: 3, label: "展示" }, { startSeconds: 2, endSeconds: 4 }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ startSeconds: 1, endSeconds: 3, durationSeconds: 2, label: "展示", hasAudio: true, sizeBytes: 1024, contentType: "video/mp4" });
    expect(result[0].filePath).not.toBe(result[1].filePath);
    for (const entry of result) {
      expect(path.isAbsolute(entry.filePath)).toBe(true);
      expect(path.basename(entry.filePath)).toMatch(/^[a-f0-9-]{36}\.mp4$/);
      expect(await fs.stat(entry.filePath)).toHaveProperty("size", 1024);
    }
    expect(await files()).toHaveLength(2);
    expect(await fs.stat(asset.videoPath!)).toHaveProperty("size", 1024);
    const args: string[] = state.run.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(["file,pipe", "0:v:0", "0:a:0?", "-sn", "-dn", "libx264", "veryfast", "20", "aac", "128k", "+faststart", "-fs"]));
    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
    expect(args.at(-1)).toMatch(/\.partial\.mp4$/);
    expect(state.run.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("allows silent video and probes actual duration before encoding", async () => {
    audio = false; asset.hasAudio = false;
    expect((await extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }]))[0].hasAudio).toBe(false);
    state.probe.mockResolvedValueOnce(probe(2, false));
    await expect(extractVideoClips(asset, [{ startSeconds: 2, endSeconds: 3 }])).rejects.toHaveProperty("code", "CLIP_INVALID_RANGE");
    expect(state.run).toHaveBeenCalledTimes(1);
  });
  it("rolls back completed clips and partials after a later encoding failure, preserving other files", async () => {
    const base = resolveClipsDirectory();
    const existing = path.join(base, "user.mp4"); await fs.writeFile(existing, "keep");
    const encode = state.run.getMockImplementation()!;
    state.run.mockImplementationOnce(encode).mockImplementationOnce(async (args: string[]) => {
      await fs.writeFile(args.at(-1)!, "partial"); throw Error("private diagnostic");
    });
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }])).rejects.toMatchObject({ code: "CLIP_FAILED", message: "Video clipping failed." });
    expect(await files()).toEqual([existing]);
    expect(await fs.readFile(existing, "utf8")).toBe("keep");
    expect(existsSync(asset.videoPath!)).toBe(true);
  });
  it("propagates cancellation during encoding and rolls back earlier results", async () => {
    const controller = new AbortController();
    const encode = state.run.getMockImplementation()!;
    state.run.mockImplementationOnce(encode).mockImplementationOnce(async (args: string[], opts: { signal: AbortSignal }) => {
      await fs.writeFile(args.at(-1)!, "partial"); controller.abort();
      expect(opts.signal.aborted).toBe(true);
      throw new DOMException("aborted", "AbortError");
    });
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }], controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(await files()).toEqual([]);
  });
  it("honors inherited operation cancellation before probing or creating storage", async () => {
    await expect(runWithOperationSignal(AbortSignal.abort(), () => extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }]))).rejects.toHaveProperty("name", "AbortError");
    expect(state.probe).not.toHaveBeenCalled(); expect(existsSync(state.config)).toBe(false);
  });
  it.each(["duration", "codec", "audio", "format", "dimensions", "size", "extra", "probe-failure"])("rejects invalid output %s and cleans files", async kind => {
    state.probe.mockImplementation(async (filename: string) => {
      if (!encoded.has(filename)) return probe();
      const output = probe(2);
      if (kind === "duration") output.durationSeconds = 3;
      if (kind === "codec") output.streams[0].codecName = "hevc";
      if (kind === "audio") output.streams.pop();
      if (kind === "format") output.formatName = "matroska";
      if (kind === "dimensions") output.streams[0].width = 321;
      if (kind === "size") output.sizeBytes = 9;
      if (kind === "extra") output.streams.push({ type: "other" });
      if (kind === "probe-failure") throw Error("damaged");
      return output;
    });
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 2 }])).rejects.toHaveProperty("code", "CLIP_FAILED");
    expect(await files()).toEqual([]);
  });
  it.each(["asset-size", "actual-size", "source-duration", "no-video", "missing-audio", "url"])("rejects unusable source %s before encoding", async kind => {
    if (kind === "asset-size") asset.sizeBytes = 512 * 1024 * 1024 + 1;
    if (kind === "actual-size") await fs.truncate(asset.videoPath!, 512 * 1024 * 1024 + 1);
    if (kind === "source-duration") state.probe.mockResolvedValue(probe(7201));
    if (kind === "no-video") state.probe.mockResolvedValue({ ...probe(), streams: [{ type: "audio", codecName: "aac" }] });
    if (kind === "missing-audio") state.probe.mockResolvedValue(probe(10, false));
    if (kind === "url") asset.videoPath = "https://example.com/video.mp4";
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }])).rejects.toThrow();
    expect(state.run).not.toHaveBeenCalled();
  });
  it("enforces the output disk limit and cleans oversized partials", async () => {
    state.run.mockImplementation(async (args: string[]) => {
      const handle = await fs.open(args.at(-1)!, "r+");
      await handle.truncate(256 * 1024 * 1024 + 1); await handle.close();
    });
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }])).rejects.toHaveProperty("code", "CLIP_LIMIT_EXCEEDED");
    expect(await files()).toEqual([]);
  });
  it("accounts for completed files in the shared output budget and rolls all of them back", async () => {
    state.run.mockImplementation(async (args: string[]) => {
      encoded.set(args.at(-1)!, Number(args[args.indexOf("-t") + 1]));
      await fs.truncate(args.at(-1)!, 140 * 1024 * 1024);
    });
    state.probe.mockImplementation(async (filename: string) => ({ ...probe(encoded.get(filename) ?? 10),
      sizeBytes: encoded.has(filename) ? 140 * 1024 * 1024 : 1024 }));
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }, { startSeconds: 2, endSeconds: 3 }])).rejects.toHaveProperty("code", "CLIP_LIMIT_EXCEEDED");
    expect(await files()).toEqual([]);
  });
  it("aborts an encoder that exceeds the disk budget while running", async () => {
    state.run.mockImplementation(async (args: string[], opts: { signal: AbortSignal }) => {
      await fs.truncate(args.at(-1)!, 256 * 1024 * 1024 + 1);
      await new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    });
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }])).rejects.toHaveProperty("code", "CLIP_LIMIT_EXCEEDED");
    expect(await files()).toEqual([]);
  });
  it("limits active tasks, isolates concurrent output, and releases slots", async () => {
    const release: Array<() => void> = [];
    const encode = state.run.getMockImplementation()!;
    state.run.mockImplementation(async (...args: unknown[]) => { await new Promise<void>(resolve => release.push(resolve)); return encode(...args); });
    const ranges = [{ startSeconds: 0, endSeconds: 1 }];
    const a = extractVideoClips(asset, ranges); const b = extractVideoClips(asset, ranges);
    await expect(extractVideoClips(asset, ranges)).rejects.toHaveProperty("code", "CLIP_LIMIT_EXCEEDED");
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach(resolve => resolve());
    const [first, second] = await Promise.all([a, b]);
    expect(path.dirname(first[0].filePath)).not.toBe(path.dirname(second[0].filePath));
    state.run.mockImplementation(encode);
    await expect(extractVideoClips(asset, ranges)).resolves.toHaveLength(1);
  });
  it("preserves an unavailable-FFmpeg error, cleaning the reserved partial", async () => {
    state.run.mockRejectedValue(new FfmpegUnavailableError());
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }])).rejects.toBeInstanceOf(FfmpegUnavailableError);
    expect(await files()).toEqual([]);
  });
  it("cleans up after a timed out encoder", async () => {
    state.run.mockRejectedValue(Object.assign(Error("timeout"), { code: "MEDIA_PROBE_FAILED" }));
    await expect(extractVideoClips(asset, [{ startSeconds: 0, endSeconds: 1 }])).rejects.toHaveProperty("code", "CLIP_FAILED");
    expect(state.run.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(360_000);
    expect(await files()).toEqual([]);
  });
});

describe("directory safety", () => {
  it("creates and verifies persistent storage and rejects a regular file", async () => {
    expect(resolveClipsDirectory()).toBe(path.join(state.config, "clips"));
    await fs.rmdir(path.join(state.config, "clips"));
    await fs.writeFile(path.join(state.config, "clips"), "user file");
    expect(() => resolveClipsDirectory()).toThrow();
    expect(await fs.readFile(path.join(state.config, "clips"), "utf8")).toBe("user file");
  });
  it("rejects linked config/output directories, without deleting their contents", async () => {
    const target = path.join(root, "target"); await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep"), "safe");
    await fs.symlink(target, state.config, process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveClipsDirectory()).toThrow();
    await fs.unlink(state.config); await fs.mkdir(state.config);
    await fs.symlink(target, path.join(state.config, "clips"), process.platform === "win32" ? "junction" : "dir");
    expect(() => resolveClipsDirectory()).toThrow();
    expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("safe");
  });
  it.skipIf(process.platform === "win32")("rejects directories writable by other accounts", async () => {
    resolveClipsDirectory(); await fs.chmod(path.join(state.config, "clips"), 0o777);
    expect(() => resolveClipsDirectory()).toThrow();
  });
});

const ffmpeg = process.env.BILIBILI_FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.BILIBILI_FFPROBE_PATH ?? "ffprobe";
const realTools = spawnSync(ffmpeg, ["-version"], { stdio: "ignore", timeout: 10_000 }).status === 0 &&
  spawnSync(ffprobe, ["-version"], { stdio: "ignore", timeout: 10_000 }).status === 0;

describe.skipIf(!realTools)("real FFmpeg clips", () => {
  it.each([true, false])("encodes independent decodable clips with audio=%s and accurate visual boundaries", async hasAudio => {
    const actual = await vi.importActual<typeof import("../src/media/ffmpeg.js")>("../src/media/ffmpeg.js");
    state.run.mockImplementation(actual.runFfmpeg); state.probe.mockImplementation(actual.probeMediaFile);
    // First two seconds red, last two blue: extraction at t=2 must start blue.
    await actual.runFfmpeg(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=322x242:r=25:d=2",
      "-f", "lavfi", "-i", "color=blue:s=322x242:r=25:d=2", ...(hasAudio ? [
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2",
      ] : []),
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]" + (hasAudio ? ";[2:a][3:a]concat=n=2:v=0:a=1[a]" : ""),
      "-map", "[v]", ...(hasAudio ? ["-map", "[a]", "-c:a", "aac"] : []),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", asset.videoPath!]);
    const info = await actual.probeMediaFile(asset.videoPath!);
    asset.sizeBytes = info.sizeBytes; asset.durationSeconds = info.durationSeconds; asset.hasAudio = hasAudio;
    const result = await extractVideoClips(asset, [{ startSeconds: 0.2, endSeconds: 1.2, label: "red" }, { startSeconds: 2, endSeconds: 3.4, label: "blue" }]);
    for (const [index, clip] of result.entries()) {
      expect(clip.hasAudio).toBe(hasAudio);
      expect(Math.abs(clip.durationSeconds - (index === 0 ? 1 : 1.4))).toBeLessThanOrEqual(0.25);
      const checked = await actual.probeMediaFile(clip.filePath);
      expect(checked.streams[0]).toMatchObject({ codecName: "h264", width: 322, height: 242 });
      if (hasAudio) expect(checked.streams.find(s => s.type === "audio")?.codecName).toBe("aac");
      await actual.runFfmpeg(["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", clip.filePath, "-f", "null", "-"]);
      const frame = spawnSync(ffmpeg, ["-v", "error", "-i", clip.filePath, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 10_000 });
      expect(frame.status).toBe(0);
      expect(frame.stdout.length).toBe(3);
      expect(frame.stdout[index === 0 ? 0 : 2]).toBeGreaterThan(200);
      expect(frame.stdout[index === 0 ? 2 : 0]).toBeLessThan(30);
      if (hasAudio) {
        const pcm = spawnSync(ffmpeg, ["-v", "error", "-i", clip.filePath, "-ss", "0.2", "-t", "0.3", "-vn",
          "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"], { timeout: 10_000 });
        expect(pcm.status).toBe(0);
        let crossings = 0;
        for (let offset = 2; offset < pcm.stdout.length; offset += 2) {
          if (pcm.stdout.readInt16LE(offset - 2) < 0 && pcm.stdout.readInt16LE(offset) >= 0) crossings++;
        }
        const measuredHz = crossings / (pcm.stdout.length / 2 / 48000);
        expect(Math.abs(measuredHz - (index === 0 ? 440 : 880))).toBeLessThan(20);
      }
    }
    expect(await files()).toHaveLength(2);
  }, 60_000);
  it("caps high resolution output at 1920x1080 and supports a range ending at the source boundary", async () => {
    const actual = await vi.importActual<typeof import("../src/media/ffmpeg.js")>("../src/media/ffmpeg.js");
    state.run.mockImplementation(actual.runFfmpeg); state.probe.mockImplementation(actual.probeMediaFile);
    await actual.runFfmpeg(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=green:size=2048x1152:rate=25:duration=2",
      "-c:v", "libx264", "-threads", "2", asset.videoPath!]);
    const info = await actual.probeMediaFile(asset.videoPath!);
    asset.sizeBytes = info.sizeBytes; asset.durationSeconds = info.durationSeconds; asset.hasAudio = false;
    const [result] = await extractVideoClips(asset, [{ startSeconds: 1, endSeconds: 2 }]);
    const output = await actual.probeMediaFile(result.filePath);
    expect(output.streams[0]).toMatchObject({ width: 1920, height: 1080, codecName: "h264" });
    expect(Math.abs(output.durationSeconds - 1)).toBeLessThanOrEqual(0.25);
    await actual.runFfmpeg(["-nostdin", "-v", "error", "-i", result.filePath, "-f", "null", "-"]);
  }, 60_000);
  it("scales portrait video proportionally, rounds odd dimensions down and never enlarges", async () => {
    const actual = await vi.importActual<typeof import("../src/media/ffmpeg.js")>("../src/media/ffmpeg.js");
    state.run.mockImplementation(actual.runFfmpeg); state.probe.mockImplementation(actual.probeMediaFile);
    await actual.runFfmpeg(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=321x641:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-threads", "2", asset.videoPath!]);
    const info = await actual.probeMediaFile(asset.videoPath!);
    asset.sizeBytes = info.sizeBytes; asset.durationSeconds = info.durationSeconds; asset.hasAudio = false;
    const [result] = await extractVideoClips(asset, [{ startSeconds: 0.4, endSeconds: 2.4 }]);
    const output = await actual.probeMediaFile(result.filePath);
    const video = output.streams.find(s => s.type === "video")!;
    expect(video.width! % 2).toBe(0); expect(video.height! % 2).toBe(0);
    expect(video.width!).toBeLessThanOrEqual(321); expect(video.height!).toBeLessThanOrEqual(641);
    expect(Math.abs(video.width! / video.height! - 321 / 641)).toBeLessThan(0.01);
  }, 60_000);
});
