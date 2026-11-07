import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeMediaFile, resolveFfmpegPath, resolveFfprobePath, runFfmpeg } from "../src/media/ffmpeg.js";
import { createMediaTempDir, cleanupMediaTempDir } from "../src/media/temp.js";
import { acquireVideoMedia, registerMediaSource, releaseMediaAsset, setPlatformMediaFetch } from "../src/media/acquire.js";
const hasFfmpeg = spawnSync(resolveFfmpegPath(), ["-version"], { windowsHide: true, timeout: 5000 }).status === 0;
const hasFfprobe = spawnSync(resolveFfprobePath(), ["-version"], { windowsHide: true, timeout: 5000 }).status === 0;
async function synthesize(file: string) {
  await runFfmpeg(["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", file]);
}
describe("real local FFmpeg integration", () => {
  it.skipIf(!hasFfmpeg)("generates synthetic video and audio in an owned temporary directory", async () => {
    const dir = await createMediaTempDir();
    try { const file = path.join(dir, "synthetic.mp4"); await synthesize(file); expect((await fs.stat(file)).size).toBeGreaterThan(1000); }
    finally { await cleanupMediaTempDir(dir); }
  }, 30_000);
  it.skipIf(!hasFfmpeg || !hasFfprobe)("probes progressive media, muxes downloaded local tracks, and acquires audio only", async () => {
    const dir = await createMediaTempDir();
    try {
      const file = path.join(dir, "synthetic.mp4"); await synthesize(file);
      const probe = await probeMediaFile(file); expect(probe.durationSeconds).toBeCloseTo(2, 0); expect(probe.streams.map(s => s.type)).toEqual(expect.arrayContaining(["video", "audio"]));
      const videoPath = path.join(dir, "video.mp4"); const audioPath = path.join(dir, "audio.m4a");
      for (const [map, output] of [["0:v:0", videoPath], ["0:a:0", audioPath]]) await runFfmpeg(["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", file, "-map", map, "-c", "copy", output]);
      let split = false;
      const video = { url: "https://synthetic.bilivideo.com/video", mimeType: "video/mp4" };
      const audio = { url: "https://synthetic.bilivideo.com/audio", mimeType: "audio/mp4" };
      registerMediaSource({ platform: "bilibili", getMediaCandidates: async () => split ? { split: { video: [video], audio: [audio] } } : { progressive: [video] } });
      setPlatformMediaFetch("bilibili", async input => new Response(await fs.readFile(String(input).endsWith("audio") ? audioPath : split ? videoPath : file), { headers: { "content-type": "video/mp4" } }));
      const source = { platform: "bilibili" as const, videoId: "synthetic", title: "synthetic", canonicalUrl: "https://www.bilibili.com", durationSeconds: 2 };
      const progressive = await acquireVideoMedia(source, { purpose: "clips" });
      try { expect(progressive.hasVideo && progressive.hasAudio).toBe(true); } finally { await releaseMediaAsset(progressive); }
      const extracted = await acquireVideoMedia(source, { purpose: "transcript" });
      const extractedDir = path.dirname(extracted.audioPath!);
      try {
        expect(extracted.hasVideo).toBe(false); expect(extracted.hasAudio).toBe(true); expect(extracted.videoPath).toBeUndefined();
        const audioProbe = await probeMediaFile(extracted.audioPath!);
        expect(audioProbe.streams.map(stream => stream.type)).toEqual(["audio"]);
        expect(audioProbe.streams[0].codecName).toBe("aac"); expect(audioProbe.durationSeconds).toBeCloseTo(2, 0);
        expect(audioProbe.sizeBytes).toBeLessThan(128 * 1024 * 1024);
        expect((await fs.readdir(extractedDir)).sort()).toEqual(["audio.m4a", "video.mp4"]);
      } finally { await releaseMediaAsset(extracted); }
      await expect(fs.stat(extractedDir)).rejects.toHaveProperty("code", "ENOENT");
      split = true;
      const muxed = await acquireVideoMedia(source, { purpose: "clips" });
      try { expect(muxed.hasVideo && muxed.hasAudio).toBe(true); expect((await probeMediaFile(muxed.videoPath!)).durationSeconds).toBeCloseTo(2, 0); } finally { await releaseMediaAsset(muxed); }
      const audioOnly = await acquireVideoMedia(source, { purpose: "transcript" });
      try { expect(audioOnly.hasVideo).toBe(false); expect(audioOnly.hasAudio).toBe(true); expect(audioOnly.videoPath).toBeUndefined(); } finally { await releaseMediaAsset(audioOnly); }
    } finally { await cleanupMediaTempDir(dir); }
  }, 30_000);
});
