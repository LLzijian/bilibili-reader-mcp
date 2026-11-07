import fs from "node:fs/promises";
import path from "node:path";
import type { MediaAsset } from "./types.js";
import { probeMediaFile, runFfmpeg } from "./ffmpeg.js";
import { cleanupMediaTempDir, createMediaTempDir } from "./temp.js";
import { getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { FfmpegUnavailableError, KeyframeError, ValidationError } from "../utils/errors.js";

export interface Keyframe { timestampSeconds: number; image: Buffer; score?: number; reason?: string; }
export interface KeyframeOptions { maxFrames: number; strategy?: "balanced" | "scene-change" | "uniform"; }
export const KEYFRAME_LIMITS = Object.freeze({
  minFrames: 1, maxFrames: 12, defaultFrames: 6, maxCandidates: 120, maxDurationSeconds: 7200,
} as const);

// Leave room for the handler's base64 expansion and aggregate response budget.
const FRAME_BYTES = 192 * 1024;
const GRAY_BYTES = 9 * 8;
const TIMEOUT_MS = 180_000;
const MAX_OPERATIONS = 2;
let activeOperations = 0;

export function validateKeyframeOptions(raw: unknown): KeyframeOptions {
  if (raw === undefined) raw = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("Keyframe options must be an object.");
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "maxFrames" && key !== "strategy")) {
    throw new ValidationError("Unknown keyframe option.");
  }
  const maxFrames = value.maxFrames === undefined ? KEYFRAME_LIMITS.defaultFrames : value.maxFrames;
  const strategy = value.strategy === undefined ? "balanced" : value.strategy;
  if (typeof maxFrames !== "number" || !Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 12) {
    throw new ValidationError("maxFrames must be an integer between 1 and 12.");
  }
  if (strategy !== "balanced" && strategy !== "scene-change" && strategy !== "uniform") {
    throw new ValidationError("Unknown keyframe strategy.");
  }
  return { maxFrames, strategy };
}

interface Candidate {
  timestampSeconds: number;
  scene: boolean;
  hash: bigint;
  average: number;
}

/** @internal Pure 64-bit dHash plus luminance (flat different colors share a dHash). */
export function hashGrayscaleFrame(gray: Uint8Array): { hash: bigint; average: number } {
  if (gray.length !== GRAY_BYTES) throw new ValidationError("Expected a 9 by 8 grayscale frame.");
  let hash = 0n;
  let sum = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      sum += gray[y * 9 + x];
      if (x < 8) hash = (hash << 1n) | BigInt(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
    }
  }
  return { hash, average: sum / GRAY_BYTES };
}
function similar(a: Candidate, b: Candidate): boolean {
  let bits = a.hash ^ b.hash;
  let distance = 0;
  while (bits !== 0n) { bits &= bits - 1n; distance++; }
  return distance <= 6 && Math.abs(a.average - b.average) <= 12;
}

/** @internal One representative per time bin; similarity only penalizes nearby repeats. */
export function selectKeyframeCandidates(
  candidates: readonly Candidate[], duration: number, count: number,
  strategy: NonNullable<KeyframeOptions["strategy"]>,
): Candidate[] {
  const selected: Candidate[] = [];
  const binWidth = duration / count;
  for (let bin = 0; bin < count; bin++) {
    const center = (bin + 0.5) * binWidth;
    const available = candidates.filter((c) => c.timestampSeconds >= bin * binWidth &&
      c.timestampSeconds < (bin + 1) * binWidth);
    let best: Candidate | undefined;
    let bestScore = -Infinity;
    for (const candidate of available) {
      const coverage = 1 - Math.abs(candidate.timestampSeconds - center) / binWidth;
      const sceneBonus = strategy === "uniform" ? 0 : candidate.scene ? (strategy === "scene-change" ? 1.2 : 0.7) : 0;
      const repeat = selected.some((previous) =>
        Math.abs(candidate.timestampSeconds - previous.timestampSeconds) < binWidth * 0.65 && similar(candidate, previous));
      const score = coverage + sceneBonus - (repeat ? 2 : 0);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (best) selected.push(best);
  }
  return selected.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

async function readBounded(file: string, limit: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) {
    throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "Extracted frame exceeded its byte limit.");
  }
  // Files live in our private directory and their producer has already exited.
  const data = await fs.readFile(file);
  if (data.length !== stat.size || data.length > limit) {
    throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "Extracted frame changed size.");
  }
  return data;
}
function localFile(file: string): boolean { return path.isAbsolute(file) && !file.startsWith("\\\\") && !file.startsWith("//"); }
function ptsTimes(stderr: string): number[] {
  return [...stderr.matchAll(/\bpts_time:([\d.eE+\-]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
}
const inputArgs = (file: string, seek?: number): string[] => [
  "-hide_banner", "-nostdin", "-y", "-loglevel", "info", "-threads", "1",
  "-protocol_whitelist", "file,pipe", ...(seek === undefined ? [] : ["-ss", seek.toFixed(6)]), "-i", file,
  "-map", "0:v:0", "-an", "-sn", "-dn", "-filter_threads", "1", "-threads", "1",
];

export async function extractKeyframes(asset: MediaAsset, options: KeyframeOptions, signal?: AbortSignal): Promise<Keyframe[]> {
  const validated = validateKeyframeOptions(options);
  const callerSignal = getOperationSignal(signal);
  throwIfAborted(callerSignal);
  if (!asset.hasVideo || !asset.videoPath) throw new KeyframeError("KEYFRAME_NO_VIDEO", "Media has no video track.");
  if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0 || asset.durationSeconds > KEYFRAME_LIMITS.maxDurationSeconds) {
    throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "Video duration must be positive and at most 7200 seconds.");
  }
  if (!localFile(asset.videoPath)) throw new KeyframeError("KEYFRAME_FAILED", "A local absolute media path is required.");
  if (activeOperations >= MAX_OPERATIONS) throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "Keyframe extraction is busy; retry later.", true);
  activeOperations++;
  const controller = new AbortController();
  const operationSignal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let dir: string | undefined;
  try {
    const probe = await probeMediaFile(asset.videoPath, operationSignal);
    if (!probe.streams.some((stream) => stream.type === "video")) throw new KeyframeError("KEYFRAME_NO_VIDEO", "Media has no video track.");
    const duration = probe.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0 || duration > KEYFRAME_LIMITS.maxDurationSeconds) {
      throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "Probed video duration exceeds the limit.");
    }
    dir = await createMediaTempDir();
    throwIfAborted(operationSignal);
    const count = Math.min(validated.maxFrames, Math.max(1, Math.floor(duration / 0.25)));
    const uniformCount = Math.min(48, count * 4, Math.max(1, Math.floor(duration / 0.125)));
    const times: { timestampSeconds: number; scene: boolean }[] = Array.from({ length: uniformCount }, (_, i) => ({
      timestampSeconds: i === 0 ? 0 : duration * (i + 0.5) / uniformCount, scene: false,
    }));
    if (validated.strategy !== "uniform") {
      const sceneLimit = KEYFRAME_LIMITS.maxCandidates - uniformCount;
      // fps limits analysis work and showinfo only sees at most sceneLimit selected frames.
      const { stderr } = await runFfmpeg([...inputArgs(asset.videoPath), "-t", String(duration), "-vf",
        "fps=4,scale=320:180:force_original_aspect_ratio=decrease,select='gt(scene,0.30)',showinfo",
        "-frames:v", String(sceneLimit), "-f", "null", "-"],
      { signal: operationSignal, timeoutMs: 90_000, maxStderrBytes: 96 * 1024 });
      for (const timestampSeconds of ptsTimes(stderr).slice(0, sceneLimit)) {
        if (timestampSeconds >= 0 && timestampSeconds < duration &&
          !times.some((candidate) => Math.abs(candidate.timestampSeconds - timestampSeconds) < 0.04)) {
          times.push({ timestampSeconds, scene: true });
        }
      }
    }
    const candidates: Candidate[] = [];
    for (const [index, candidate] of times.sort((a, b) => a.timestampSeconds - b.timestampSeconds).entries()) {
      throwIfAborted(operationSignal);
      const file = path.join(dir, `gray-${index}.raw`);
      const { stderr } = await runFfmpeg([...inputArgs(asset.videoPath, candidate.timestampSeconds), "-vf", "scale=9:8,format=gray,showinfo",
        "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-fs", String(GRAY_BYTES), file],
      { signal: operationSignal, timeoutMs: 15_000, maxStderrBytes: 8192 });
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      // A seek near EOF can be past the final presentation frame on low-fps media.
      if (!stat || stat.size === 0) { if (stat) await fs.unlink(file); continue; }
      const pixels = await readBounded(file, GRAY_BYTES);
      const offset = ptsTimes(stderr)[0];
      if (offset === undefined) throw new KeyframeError("KEYFRAME_FAILED", "Frame timestamp is missing.");
      const timestampSeconds = Math.max(0, Number(candidate.timestampSeconds.toFixed(6)) + offset);
      if (timestampSeconds < duration && !candidates.some((previous) => Math.abs(previous.timestampSeconds - timestampSeconds) < 0.001)) {
        candidates.push({ ...candidate, timestampSeconds, ...hashGrayscaleFrame(pixels) });
      }
      await fs.unlink(file);
    }
    const selected = selectKeyframeCandidates(candidates, duration, count, validated.strategy ?? "balanced");
    const frames: Keyframe[] = [];
    for (const [index, candidate] of selected.entries()) {
      throwIfAborted(operationSignal);
      const file = path.join(dir, `frame-${index}.jpg`);
      let image: Buffer | undefined;
      // Retry with smaller dimensions and stronger JPEG compression under the per-frame budget.
      for (const [width, quality] of [[1280, 4], [960, 8], [640, 12], [320, 18]]) {
        const { stderr } = await runFfmpeg([...inputArgs(asset.videoPath, Number(candidate.timestampSeconds.toFixed(6))), "-vf",
          `scale=w='min(${width},iw)':h='min(${width},ih)':force_original_aspect_ratio=decrease,showinfo`,
          "-frames:v", "1", "-c:v", "mjpeg", "-q:v", String(quality), "-fs", String(FRAME_BYTES), file],
        { signal: operationSignal, timeoutMs: 15_000, maxStderrBytes: 8192 });
        const stat = await fs.lstat(file);
        if (stat.size > FRAME_BYTES) continue;
        image = await readBounded(file, FRAME_BYTES);
        if (image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) {
          throw new KeyframeError("KEYFRAME_FAILED", "FFmpeg did not produce a complete JPEG.");
        }
        const offset = ptsTimes(stderr)[0];
        if (offset === undefined) throw new KeyframeError("KEYFRAME_FAILED", "JPEG timestamp is missing.");
        const actualTime = Number(candidate.timestampSeconds.toFixed(6)) + offset;
        if (actualTime >= duration) throw new KeyframeError("KEYFRAME_FAILED", "JPEG timestamp is outside the video.");
        frames.push({ timestampSeconds: actualTime, image, score: candidate.scene ? 1 : 0,
          reason: candidate.scene ? "Scene change within time coverage bin" : "Uniform timeline coverage" });
        break;
      }
      if (!image) throw new KeyframeError("KEYFRAME_LIMIT_EXCEEDED", "JPEG exceeds the frame byte budget.");
      await fs.unlink(file);
    }
    throwIfAborted(operationSignal);
    if (!frames.length) throw new KeyframeError("KEYFRAME_FAILED", "No video frames could be extracted.");
    return frames.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  } catch (error) {
    throwIfAborted(callerSignal);
    if (controller.signal.aborted) throw new KeyframeError("KEYFRAME_FAILED", "Keyframe extraction timed out.", true);
    if (error instanceof KeyframeError || error instanceof FfmpegUnavailableError) throw error;
    throw new KeyframeError("KEYFRAME_FAILED", "Keyframe extraction failed.");
  } finally {
    clearTimeout(timer);
    try { if (dir) await cleanupMediaTempDir(dir); }
    finally { activeOperations--; }
  }
}
