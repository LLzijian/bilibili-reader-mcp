import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaCandidateSet, VideoSource } from "../src/platforms/types.js";
const mock = vi.hoisted(() => ({ probe: vi.fn(), mux: vi.fn(), fetch: vi.fn(), created: [] as string[] }));
vi.mock("../src/media/ffmpeg.js", () => ({ probeMediaFile: mock.probe, runFfmpeg: mock.mux }));
vi.mock("../src/media/temp.js", async original => {
  const actual = await original<typeof import("../src/media/temp.js")>();
  return { ...actual, createMediaTempDir: async () => { const dir = await actual.createMediaTempDir(); mock.created.push(dir); return dir; } };
});
vi.mock("../src/security/pinned-https.js", async original => ({ ...await original<object>(), pinnedHttpsFetch: mock.fetch }));
import { acquireVideoMedia, getRegisteredMediaSource, registerMediaSource, releaseMediaAsset, setPlatformMediaFetch, withMediaAsset } from "../src/media/acquire.js";
import { MediaError, FfmpegUnavailableError } from "../src/utils/errors.js";
import { FakeIpDnsError } from "../src/security/pinned-https.js";
const source: VideoSource = { platform: "bilibili", videoId: "BV1xx411c7mD", canonicalUrl: "https://www.bilibili.com/video/BV1xx411c7mD", title: "synthetic", durationSeconds: 2 };
const video = { url: "https://cdn.bilivideo.com/video", mimeType: "video/mp4" };
const audio = { url: "https://cdn.bilivideo.com/audio", mimeType: "audio/mp4" };
const getCandidates = vi.fn<() => Promise<MediaCandidateSet>>();
registerMediaSource({ platform: "bilibili", getMediaCandidates: getCandidates });
beforeEach(() => {
  vi.clearAllMocks(); mock.created.length = 0;
  getCandidates.mockResolvedValue({ progressive: [video] });
  mock.fetch.mockImplementation(async () => new Response("media", { headers: { "content-type": "video/mp4" } }));
  mock.probe.mockImplementation(async (file: string) => ({ durationSeconds: 2, sizeBytes: 5, streams: path.basename(file).startsWith("audio.m4a") ? [{ type: "audio" }] : [{ type: "video" }, { type: "audio" }] }));
  mock.mux.mockImplementation(async (args: string[]) => { await fs.writeFile(args.at(-1)!, "muxed"); return { stderr: "" }; });
});
afterEach(async () => {
  for (const dir of mock.created) await fs.rm(dir, { recursive: true, force: true });
});
describe("unified media acquisition", () => {
  it("admits only two of eight concurrent acquisitions before candidate or network work", async () => {
    let resolveCandidates!: (set: MediaCandidateSet) => void;
    const gate = new Promise<MediaCandidateSet>(resolve => { resolveCandidates = resolve; });
    getCandidates.mockImplementation(() => gate);
    const outcomes = Array.from({ length: 8 }, () => acquireVideoMedia(source, { purpose: "keyframes" })
      .then(asset => ({ asset, error: undefined }), error => ({ asset: undefined, error })));
    expect(getCandidates).toHaveBeenCalledTimes(2); expect(mock.fetch).not.toHaveBeenCalled();
    resolveCandidates({ progressive: [video] });
    const results = await Promise.all(outcomes);
    try {
      expect(results.filter(result => result.asset)).toHaveLength(2);
      const refused = results.filter(result => result.error);
      expect(refused).toHaveLength(6);
      for (const result of refused) expect(result.error).toMatchObject({ code: "MEDIA_LIMIT_EXCEEDED" });
      expect(getCandidates).toHaveBeenCalledTimes(2); expect(mock.fetch).toHaveBeenCalledTimes(2);
    } finally { await Promise.all(results.flatMap(result => result.asset ? [releaseMediaAsset(result.asset)] : [])); }
  });
  it("holds successful slots until lease release and cannot double-release a slot", async () => {
    const first = await acquireVideoMedia(source, { purpose: "keyframes" });
    const second = await acquireVideoMedia(source, { purpose: "keyframes" });
    let replacement: Awaited<ReturnType<typeof acquireVideoMedia>> | undefined;
    try {
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
      expect(getCandidates).toHaveBeenCalledTimes(2); expect(mock.fetch).toHaveBeenCalledTimes(2);
      await Promise.all([releaseMediaAsset(first), releaseMediaAsset(first)]);
      replacement = await acquireVideoMedia(source, { purpose: "keyframes" });
      await releaseMediaAsset(first);
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
      expect(getCandidates).toHaveBeenCalledTimes(3);
    } finally {
      await releaseMediaAsset(first); await releaseMediaAsset(second);
      if (replacement) await releaseMediaAsset(replacement);
    }
  });
  it("releases a slot when candidate resolution fails before creating a directory", async () => {
    const held = await acquireVideoMedia(source, { purpose: "keyframes" });
    let replacement: Awaited<ReturnType<typeof acquireVideoMedia>> | undefined;
    try {
      getCandidates.mockRejectedValueOnce(new MediaError("MEDIA_CANDIDATES_UNAVAILABLE", "synthetic failure"));
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_CANDIDATES_UNAVAILABLE");
      expect(mock.created).toHaveLength(1);
      replacement = await acquireVideoMedia(source, { purpose: "keyframes" });
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    } finally { await releaseMediaAsset(held); if (replacement) await releaseMediaAsset(replacement); }
  });
  it("restores a cancelled download's slot while another asset remains leased", async () => {
    const held = await acquireVideoMedia(source, { purpose: "keyframes" });
    const controller = new AbortController();
    let replacement: Awaited<ReturnType<typeof acquireVideoMedia>> | undefined;
    try {
      mock.fetch.mockImplementationOnce(() => new Promise(() => {}));
      const outcome = acquireVideoMedia(source, { purpose: "keyframes" }, controller.signal).catch(error => error);
      await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
      controller.abort(); await expect(outcome).resolves.toHaveProperty("name", "AbortError");
      replacement = await acquireVideoMedia(source, { purpose: "keyframes" });
      await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    } finally { controller.abort(); await releaseMediaAsset(held); if (replacement) await releaseMediaAsset(replacement); }
  });
  it("withMediaAsset returns its slot after callback failure", async () => {
    const held = await acquireVideoMedia(source, { purpose: "keyframes" });
    let replacement: Awaited<ReturnType<typeof acquireVideoMedia>> | undefined;
    try {
      await expect(withMediaAsset(source, { purpose: "keyframes" }, async () => {
        await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
        throw new Error("callback failure");
      })).rejects.toThrow("callback failure");
      replacement = await acquireVideoMedia(source, { purpose: "keyframes" });
    } finally { await releaseMediaAsset(held); if (replacement) await releaseMediaAsset(replacement); }
  });
  it.each(["frames", "keyframes"] as const)("accepts positive subsecond media for %s", async purpose => {
    mock.probe.mockResolvedValue({ durationSeconds: 0.4, sizeBytes: 5, streams: [{ type: "video" }] });
    const asset = await acquireVideoMedia(source, { purpose });
    try { expect(asset.durationSeconds).toBe(0.4); expect(asset.hasVideo).toBe(true); }
    finally { await releaseMediaAsset(asset); }
  });
  it.each([0, -0.1])("rejects nonpositive duration %s", async durationSeconds => {
    mock.probe.mockResolvedValue({ durationSeconds, sizeBytes: 5, streams: [{ type: "video" }] });
    await expect(acquireVideoMedia(source, { purpose: "keyframes" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
  });
  it("retains the one-second minimum for clips", async () => {
    mock.probe.mockResolvedValue({ durationSeconds: 0.4, sizeBytes: 5, streams: [{ type: "video" }] });
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
  });
  it("registers sources once", () => {
    expect(getRegisteredMediaSource("bilibili")).toBeDefined();
    expect(() => registerMediaSource({ platform: "bilibili", getMediaCandidates: getCandidates })).toThrow(/already registered/);
  });
  it("uses pinned fetch by default, returns a serializable asset and releases its lease idempotently", async () => {
    const asset = await acquireVideoMedia(source, { purpose: "clips" });
    expect(asset).toMatchObject({ hasVideo: true, hasAudio: true, durationSeconds: 2, sizeBytes: 5 });
    expect(mock.fetch).toHaveBeenCalledOnce(); expect(JSON.stringify(asset)).not.toContain("lease");
    expect(await fs.readFile(asset.videoPath!, "utf8")).toBe("media");
    await Promise.all([releaseMediaAsset(asset), releaseMediaAsset(asset)]); await releaseMediaAsset(asset);
    await expect(fs.stat(path.dirname(asset.videoPath!))).rejects.toHaveProperty("code", "ENOENT");
  });
  it("downloads both split tracks and muxes using local inputs and copy codecs", async () => {
    getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio] } });
    const asset = await acquireVideoMedia(source, { purpose: "keyframes" });
    expect(mock.fetch).toHaveBeenCalledTimes(2); expect(mock.mux).toHaveBeenCalledOnce();
    const args = mock.mux.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file,pipe", "-c", "copy", "-f", "mp4"]));
    expect(args.at(-1)).toMatch(/video\.mp4\.partial$/); expect(args.join(" ")).not.toContain("https:");
    expect(await fs.readFile(asset.videoPath!, "utf8")).toBe("muxed"); expect(asset.audioPath).toMatch(/audio\.m4a$/);
    await releaseMediaAsset(asset);
  });
  it("tries audio backup candidates when there is only one video candidate", async () => {
    const backup = { ...audio, url: audio.url + "-backup" };
    getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio, backup] } });
    mock.fetch.mockImplementation(async (url: string) => {
      if (url === audio.url) throw new Error("first audio unavailable");
      return new Response("media", { headers: { "content-type": "video/mp4" } });
    });
    const asset = await acquireVideoMedia(source, { purpose: "clips" });
    expect(mock.fetch.mock.calls.map(call => call[0])).toEqual([video.url, audio.url, video.url, backup.url]);
    expect(asset.hasAudio).toBe(true); await releaseMediaAsset(asset);
  });
  it("downloads only the audio track for transcript requests", async () => {
    getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio] } });
    const asset = await acquireVideoMedia(source, { purpose: "transcript" });
    expect(asset).toMatchObject({ hasVideo: false, hasAudio: true }); expect(asset.videoPath).toBeUndefined();
    expect(mock.fetch).toHaveBeenCalledTimes(1); expect(mock.fetch.mock.calls[0][0]).toBe(audio.url); expect(mock.mux).not.toHaveBeenCalled();
    await releaseMediaAsset(asset);
  });
  it("extracts bounded audio for progressive transcripts even when the video exceeds the ASR file limit", async () => {
    mock.probe.mockImplementation(async (file: string) => ({ durationSeconds: 2,
      sizeBytes: file.endsWith("video.mp4") ? 200 * 1024 * 1024 : 5,
      streams: file.endsWith("video.mp4") ? [{ type: "video" }, { type: "audio" }] : [{ type: "audio" }] }));
    const asset = await acquireVideoMedia(source, { purpose: "transcript" });
    expect(asset).toMatchObject({ hasVideo: false, hasAudio: true, contentType: "audio/mp4", sizeBytes: 5 });
    expect(asset.videoPath).toBeUndefined(); expect(asset.audioPath).toMatch(/audio\.m4a$/);
    const dir = path.dirname(asset.audioPath!);
    expect((await fs.readdir(dir)).sort()).toEqual(["audio.m4a", "video.mp4"]);
    const [args, options] = mock.mux.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file,pipe", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", "-fs", String(128 * 1024 * 1024)]));
    expect(args.at(-1)).toMatch(/audio\.m4a\.partial$/); expect(args.join(" ")).not.toContain("https:");
    expect(options).toMatchObject({ timeoutMs: 180_000, signal: expect.any(AbortSignal) });
    await releaseMediaAsset(asset); await expect(fs.stat(dir)).rejects.toHaveProperty("code", "ENOENT");
  });
  it.each([
    [{ durationSeconds: 2, sizeBytes: 128 * 1024 * 1024 + 1, streams: [{ type: "audio" }] }, "MEDIA_LIMIT_EXCEEDED"],
    [{ durationSeconds: 2, sizeBytes: 5, streams: [{ type: "video" }] }, "MEDIA_NO_AUDIO_TRACK"],
    [{ durationSeconds: 5, sizeBytes: 5, streams: [{ type: "audio" }] }, "MEDIA_PROBE_FAILED"],
  ])("rejects invalid extracted progressive audio %#", async (audioProbe, code) => {
    mock.probe.mockResolvedValueOnce({ durationSeconds: 2, sizeBytes: 5, streams: [{ type: "video" }, { type: "audio" }] }).mockResolvedValueOnce(audioProbe);
    await expect(acquireVideoMedia(source, { purpose: "transcript" })).rejects.toHaveProperty("code", code);
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("checks extracted audio's actual filesystem size as well as probe metadata", async () => {
    mock.mux.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1)!, "audio"); await fs.truncate(args.at(-1)!, 128 * 1024 * 1024 + 1);
      return { stderr: "" };
    });
    await expect(acquireVideoMedia(source, { purpose: "transcript" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("cleans the source and partial audio after progressive extraction failure", async () => {
    mock.mux.mockImplementation(async (args: string[]) => { await fs.writeFile(args.at(-1)!, "partial"); throw new Error("decode failed"); });
    await expect(acquireVideoMedia(source, { purpose: "transcript" })).rejects.toHaveProperty("code", "MEDIA_MUX_FAILED");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("cancels progressive audio extraction and cleans the shared lease", async () => {
    const controller = new AbortController();
    mock.mux.mockImplementation(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(acquireVideoMedia(source, { purpose: "transcript" }, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("permits video-only split input for visual tasks", async () => {
    getCandidates.mockResolvedValue({ split: { video: [video] } });
    mock.probe.mockResolvedValue({ durationSeconds: 2, sizeBytes: 5, streams: [{ type: "video" }] });
    const asset = await acquireVideoMedia(source, { purpose: "frames" }); expect(asset.hasAudio).toBe(false); expect(mock.mux).not.toHaveBeenCalled();
    await releaseMediaAsset(asset);
  });
  it.each(["Cookie", "authorization", "PROXY-AUTHORIZATION"])("rejects credential header %s before fetching", async key => {
    getCandidates.mockResolvedValue({ progressive: [video], requestHeaders: { [key]: "secret" } });
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(mock.fetch).not.toHaveBeenCalled(); expect(mock.created).toEqual([]);
  });
  it.each(["http://cdn.bilivideo.com/video", "https://u:p@cdn.bilivideo.com/video", "https://cdn.bilivideo.com:8443/video", "https://other.test/video"])("revalidates candidate URL %s", async url => {
    getCandidates.mockResolvedValue({ progressive: [{ ...video, url }] });
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED"); expect(mock.fetch).not.toHaveBeenCalled();
  });
  it("requires an explicit fetch for other platforms and accepts injected fetch", async () => {
    registerMediaSource({ platform: "douyin", getMediaCandidates: getCandidates });
    const other = { ...source, platform: "douyin" as const };
    await expect(acquireVideoMedia(other, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    const fetch = vi.fn(async () => new Response("media", { headers: { "content-type": "video/mp4" } }));
    setPlatformMediaFetch("douyin", fetch);
    const asset = await acquireVideoMedia(other, { purpose: "clips" }); expect(fetch).toHaveBeenCalledOnce(); await releaseMediaAsset(asset);
  });
  it("attempts no more than three candidates and cleans the failed lease", async () => {
    getCandidates.mockResolvedValue({ progressive: Array.from({ length: 5 }, (_, i) => ({ ...video, url: video.url + i })) });
    mock.fetch.mockRejectedValue(new Error("secret signed URL"));
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED", message: "Media download failed." });
    expect(mock.fetch).toHaveBeenCalledTimes(3); await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("uses one acquisition deadline and cleans a stalled download", async () => {
    vi.useFakeTimers();
    try {
      mock.fetch.mockImplementation(() => new Promise(() => {}));
      const outcome = acquireVideoMedia(source, { purpose: "clips" }).catch(error => error);
      await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(180_000);
      await expect(outcome).resolves.toHaveProperty("code", "MEDIA_DOWNLOAD_TIMEOUT");
      await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
    } finally { vi.useRealTimers(); }
  });
  it("enforces per-call byte budgets", async () => {
    await expect(acquireVideoMedia(source, { purpose: "clips", maxBytes: 4 })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("enforces the audio-only 128 MiB limit before writing oversized bodies", async () => {
    getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio] } });
    mock.fetch.mockResolvedValue(new Response("media", { headers: { "content-type": "audio/mp4", "content-length": String(128 * 1024 * 1024 + 1) } }));
    await expect(acquireVideoMedia(source, { purpose: "transcript" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
  });
  it("retains Fake-IP diagnostics when every candidate has that failure", async () => {
    mock.fetch.mockRejectedValue(new FakeIpDnsError());
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_FAKE_IP_DNS");
  });
  it.each([
    { durationSeconds: -1, sizeBytes: 5, streams: [{ type: "video" }] },
    { durationSeconds: 7201, sizeBytes: 5, streams: [{ type: "video" }] },
    { durationSeconds: 2, sizeBytes: 536870913, streams: [{ type: "video" }] },
  ])("rejects probe limits %#", async result => {
    mock.probe.mockResolvedValue(result);
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("reports missing audio for transcript input", async () => {
    mock.probe.mockResolvedValue({ durationSeconds: 2, sizeBytes: 5, streams: [{ type: "video" }] });
    await expect(acquireVideoMedia(source, { purpose: "transcript" })).rejects.toHaveProperty("code", "MEDIA_NO_AUDIO_TRACK");
  });
  it("cleans after mux failure and preserves unavailable-tool errors", async () => {
    getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio] } });
    mock.mux.mockRejectedValueOnce(new MediaError("MEDIA_PROBE_FAILED", "failed"));
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("code", "MEDIA_MUX_FAILED");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
    mock.mux.mockRejectedValueOnce(new FfmpegUnavailableError());
    await expect(acquireVideoMedia(source, { purpose: "clips" })).rejects.toHaveProperty("name", "FfmpegUnavailableError");
  });
  it.each(["download", "mux", "probe"])("cleans after cancellation during %s", async stage => {
    const controller = new AbortController();
    if (stage === "download") mock.fetch.mockImplementation(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    if (stage === "mux") { getCandidates.mockResolvedValue({ split: { video: [video], audio: [audio] } }); mock.mux.mockImplementation(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); }); }
    if (stage === "probe") mock.probe.mockImplementation(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(acquireVideoMedia(source, { purpose: "clips" }, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
  it("withMediaAsset releases after callback failure", async () => {
    await expect(withMediaAsset(source, { purpose: "clips" }, async () => { throw new Error("callback"); })).rejects.toThrow("callback");
    await expect(fs.stat(mock.created[0])).rejects.toHaveProperty("code", "ENOENT");
  });
});
