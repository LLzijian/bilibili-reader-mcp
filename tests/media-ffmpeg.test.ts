import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);
import { probeMediaFile, resolveFfmpegPath, resolveFfprobePath, runFfmpeg } from "../src/media/ffmpeg.js";

function child() {
  const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { queueMicrotask(() => c.emit("close", null)); return true; }) });
  mocks.spawn.mockReturnValue(c);
  return c;
}
const metadata = { format: { duration: "2.000000", size: "123", format_name: "mov,mp4" }, streams: [{ codec_type: "video", codec_name: "h264", width: 320, height: 240 }, { codec_type: "audio", codec_name: "aac" }] };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
describe("media subprocesses", () => {
  it("resolves executable overrides", () => {
    vi.stubEnv("BILIBILI_FFMPEG_PATH", "custom-ffmpeg"); vi.stubEnv("BILIBILI_FFPROBE_PATH", "custom-probe");
    expect(resolveFfmpegPath()).toBe("custom-ffmpeg"); expect(resolveFfprobePath()).toBe("custom-probe");
  });
  it("uses argv, filtered env, shell false and byte-bounded stderr", async () => {
    vi.stubEnv("MEDIA_SECRET", "secret-value");
    const c = child(); const args = ["-protocol_whitelist", "file,pipe", "-i", "local.mp4"];
    const result = runFfmpeg(args, { maxStderrBytes: 4 });
    c.stderr.write("prefix-abcdef"); c.emit("close", 0);
    await expect(result).resolves.toEqual({ stderr: "cdef" });
    expect(mocks.spawn.mock.calls[0][1]).toEqual(args);
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
    expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty("MEDIA_SECRET");
  });
  it("bounds simultaneous media subprocesses", async () => {
    const children = Array.from({ length: 4 }, () => { const c = child(); return { c, promise: runFfmpeg([]) }; });
    await expect(runFfmpeg([])).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    for (const entry of children) entry.c.emit("close", 0);
    await Promise.all(children.map(entry => entry.promise));
  });
  it("kills on timeout", async () => {
    const c = child(); await expect(runFfmpeg([], { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    expect(c.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("kills on cancellation and rejects already cancelled calls", async () => {
    const controller = new AbortController(); const c = child();
    const promise = runFfmpeg([], { signal: controller.signal }); controller.abort();
    await expect(promise).rejects.toHaveProperty("name", "AbortError"); expect(c.kill).toHaveBeenCalled();
    mocks.spawn.mockClear();
    await expect(runFfmpeg([], { signal: controller.signal })).rejects.toHaveProperty("name", "AbortError"); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(["ffmpeg", "ffprobe"])("reports missing %s without exposing paths", async (tool) => {
    const c = child(); const result = tool === "ffmpeg" ? runFfmpeg([]) : probeMediaFile("local.mp4");
    c.emit("error", Object.assign(new Error("private path"), { code: "ENOENT" }));
    await expect(result).rejects.toHaveProperty("name", "FfmpegUnavailableError");
  });
  it("rejects nonzero exit without leaking stderr", async () => {
    const c = child(); const result = runFfmpeg([]); c.stderr.write("secret signed URL"); c.emit("close", 1);
    await expect(result).rejects.toMatchObject({ code: "MEDIA_PROBE_FAILED", message: "Media process failed." });
  });
});
describe("media probe schema", () => {
  it("parses stream metadata with local-only protocol options", async () => {
    const c = child(); const result = probeMediaFile("local.mp4"); c.stdout.write(JSON.stringify(metadata)); c.emit("close", 0);
    await expect(result).resolves.toMatchObject({ durationSeconds: 2, sizeBytes: 123, streams: [{ type: "video", width: 320, height: 240 }, { type: "audio" }] });
    expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams"]));
  });
  it.each([
    "bad json", "null", "{}", JSON.stringify({ ...metadata, format: {} }),
    ...[{ duration: "-1" }, { duration: null }, { duration: {} }, { size: "9007199254740993" }, { size: "536870913" }, { size: "1.5" }, { format_name: [] }].map(change => JSON.stringify({ ...metadata, format: { ...metadata.format, ...change } })),
    ...[[{ codec_type: 42 }], [{ codec_type: "video", width: -1 }], [{ codec_type: "video", height: "240" }], [{ codec_type: "audio", codec_name: {} }]].map(streams => JSON.stringify({ ...metadata, streams })),
  ])("rejects malformed metadata %#", async output => {
    const c = child(); const result = probeMediaFile("local.mp4"); c.stdout.write(output); c.emit("close", 0);
    await expect(result).rejects.toHaveProperty("code", "MEDIA_PROBE_FAILED");
  });
  it("kills ffprobe on stdout overflow", async () => {
    const c = child(); const result = probeMediaFile("local.mp4"); c.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    await expect(result).rejects.toHaveProperty("code", "MEDIA_PROBE_FAILED"); expect(c.kill).toHaveBeenCalled();
  });
});
