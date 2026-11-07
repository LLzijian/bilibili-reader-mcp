import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GLOBAL_CONFIG_DIR } from "../utils/credentials.js";
import { ClipError, FfmpegUnavailableError } from "../utils/errors.js";
import { getOperationSignal, linkAbortSignal, throwIfAborted } from "../security/operation-context.js";
import { probeMediaFile, runFfmpeg } from "./ffmpeg.js";
import type { MediaAsset } from "./types.js";

export interface ClipRange { startSeconds: number; endSeconds: number; label?: string; }
export interface ClipResult {
  clipId: string; label?: string; startSeconds: number; endSeconds: number;
  durationSeconds: number; filePath: string; hasAudio: boolean;
  contentType: "video/mp4"; sizeBytes: number;
}
export const CLIP_LIMITS = Object.freeze({
  minClipSeconds: 1, maxClipSeconds: 180, maxClips: 5,
  maxTotalClipSeconds: 600, maxSourceDurationSeconds: 7200,
} as const);
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_CONCURRENT_TASKS = 2;
const DURATION_TOLERANCE = 0.25;
let activeTasks = 0;

function invalid(message: string): never { throw new ClipError("CLIP_INVALID_RANGE", message); }
function limit(message: string): never { throw new ClipError("CLIP_LIMIT_EXCEEDED", message); }
function failed(message: string): never { throw new ClipError("CLIP_FAILED", message); }

/** Accept internal camelCase data only; overlapping ranges remain separate. */
export function validateClipRanges(raw: unknown, sourceDurationSeconds: number): ClipRange[] {
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) invalid("Invalid source duration.");
  if (sourceDurationSeconds > CLIP_LIMITS.maxSourceDurationSeconds) limit("Source video exceeds the duration limit.");
  if (!Array.isArray(raw) || raw.length < 1) invalid("At least one clip is required.");
  if (raw.length > CLIP_LIMITS.maxClips) limit("Too many clips.");
  let total = 0;
  const result: ClipRange[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) invalid("Invalid clip range.");
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some(key => !["startSeconds", "endSeconds", "label"].includes(key))) invalid("Unknown clip field.");
    const { startSeconds, endSeconds, label } = record;
    if (typeof startSeconds !== "number" || typeof endSeconds !== "number" ||
        !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds || endSeconds > sourceDurationSeconds) invalid("Clip range is outside the source duration.");
    const duration = endSeconds - startSeconds;
    if (duration < CLIP_LIMITS.minClipSeconds) invalid("Clip is shorter than one second.");
    if (duration > CLIP_LIMITS.maxClipSeconds) limit("Clip exceeds the duration limit.");
    if (label !== undefined && (typeof label !== "string" || label.length > 80 ||
        /[\\/\x00-\x1f\x7f:]/u.test(label) || label.includes("..") ||
        path.isAbsolute(label) || path.win32.isAbsolute(label))) invalid("Invalid clip label.");
    total += duration;
    result.push({ startSeconds, endSeconds, ...(label === undefined ? {} : { label: label as string }) });
  }
  if (total > CLIP_LIMITS.maxTotalClipSeconds) limit("Total clip duration exceeds the limit.");
  return result;
}

/** Check each ancestor before creating children; never follow a directory link. */
function verifyDirectory(directory: string, create: boolean): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) failed("Unsafe clips directory.");
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) failed("Unsafe clips directory.");
    }
  }
  if (path.relative(absolute, fs.realpathSync(absolute)) !== "") failed("Unsafe clips directory real path.");
  const stat = fs.lstatSync(absolute);
  // Windows uses ACLs; POSIX additionally forbids writes by other accounts.
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) failed("Clips directory has unsafe permissions.");
  fs.accessSync(absolute, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

/** Persistent application-owned storage, independent of the source lease. */
export function resolveClipsDirectory(): string {
  try {
    verifyDirectory(GLOBAL_CONFIG_DIR, true);
    const directory = path.resolve(GLOBAL_CONFIG_DIR, "clips");
    verifyDirectory(directory, true);
    return directory;
  } catch (error) {
    if (error instanceof ClipError) throw error;
    return failed("Could not prepare the clips directory.");
  }
}

function localSource(asset: MediaAsset): string {
  if (!asset.hasVideo || !asset.videoPath) failed("Source has no video track.");
  if (!path.isAbsolute(asset.videoPath) || /^(?:https?|ftp|file|data):/i.test(asset.videoPath)) failed("A local video file is required.");
  const filename = path.resolve(asset.videoPath);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || path.relative(filename, fs.realpathSync(filename)) !== "") failed("Unsafe source video file.");
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > MAX_SOURCE_BYTES || stat.size > MAX_SOURCE_BYTES) limit("Source video exceeds the file size limit.");
  if (stat.size === 0) failed("Source video is empty.");
  return filename;
}

/** Sequential clips within each task, at most two tasks, with all-or-nothing output. */
export async function extractVideoClips(asset: MediaAsset, clips: readonly ClipRange[], signal?: AbortSignal): Promise<ClipResult[]> {
  signal = getOperationSignal(signal);
  throwIfAborted(signal);
  let ranges = validateClipRanges(clips, asset.durationSeconds);
  if (activeTasks >= MAX_CONCURRENT_TASKS) limit("Video clipping is busy; try again later.");
  activeTasks++;
  let directory: string | undefined;
  const ownedFiles = new Set<string>();
  const results: ClipResult[] = [];
  try {
    const input = localSource(asset);
    const source = await probeMediaFile(input, signal);
    throwIfAborted(signal);
    ranges = validateClipRanges(ranges, source.durationSeconds);
    if (!source.streams.some(stream => stream.type === "video")) failed("Source has no video track.");
    if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 || source.sizeBytes > MAX_SOURCE_BYTES) limit("Source video exceeds the file size limit.");
    const hasAudio = source.streams.some(stream => stream.type === "audio");
    if (asset.hasAudio && !hasAudio) failed("Source video is missing its expected audio track.");
    const root = resolveClipsDirectory();
    directory = await fsp.mkdtemp(path.join(root, "job-"));
    verifyDirectory(directory, false);
    throwIfAborted(signal);
    let completedBytes = 0;
    for (const range of ranges) {
      throwIfAborted(signal);
      verifyDirectory(directory, false);
      const clipId = randomUUID();
      const finalPath = path.join(directory, `${clipId}.mp4`);
      const partialPath = path.join(directory, `${clipId}.partial.mp4`);
      // Reserve this path exclusively before giving it to FFmpeg (-y only overwrites our file).
      const handle = await fsp.open(partialPath, "wx", 0o600);
      ownedFiles.add(partialPath);
      await handle.close();
      const duration = range.endSeconds - range.startSeconds;
      const remainingBytes = MAX_OUTPUT_BYTES - completedBytes;
      if (remainingBytes <= 1024 * 1024) limit("Clip output exceeds the disk budget.");
      const controller = new AbortController();
      const unlink = linkAbortSignal(signal, controller);
      let monitorFailure: Error | undefined;
      // Inspect during encoding as well as after it. FFmpeg's -fs is an independent hard stop.
      let pendingCheck: Promise<void> | undefined;
      const checkSize = async () => {
        try {
          const stat = await fsp.lstat(partialPath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new ClipError("CLIP_FAILED", "Unsafe clip output file.");
          if (stat.size > remainingBytes) throw new ClipError("CLIP_LIMIT_EXCEEDED", "Clip output exceeds the disk budget.");
        } catch (error) { monitorFailure = error as Error; controller.abort(); }
      };
      const timer = setInterval(() => {
        if (!pendingCheck) pendingCheck = checkSize().finally(() => { pendingCheck = undefined; });
      }, 100);
      timer.unref();
      try {
        await runFfmpeg([
          "-nostdin", "-v", "error", "-y", "-max_alloc", "67108864", "-threads", "2",
          "-protocol_whitelist", "file,pipe", "-i", input,
          "-ss", String(range.startSeconds), "-t", String(duration),
          "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
          "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-threads", "2", "-filter_threads", "1", "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-fs", String(remainingBytes - 1024 * 1024), partialPath,
        ], { signal: controller.signal, timeoutMs: 360_000, maxStderrBytes: 2048 });
      } catch (error) { throw monitorFailure ?? error; }
      finally { clearInterval(timer); await pendingCheck; unlink(); }
      if (monitorFailure) throw monitorFailure;
      throwIfAborted(signal);
      const stat = await fsp.lstat(partialPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) failed("Clip output is invalid.");
      if (stat.size >= remainingBytes - 1024 * 1024) limit("Clip output reached the disk budget.");
      const output = await probeMediaFile(partialPath, signal);
      throwIfAborted(signal);
      const videos = output.streams.filter(stream => stream.type === "video");
      const audios = output.streams.filter(stream => stream.type === "audio");
      if (!output.formatName?.split(",").includes("mp4") || videos.length !== 1 || videos[0].codecName !== "h264" ||
          !videos[0].width || !videos[0].height || videos[0].width % 2 !== 0 || videos[0].height % 2 !== 0 ||
          videos[0].width > 1920 || videos[0].height > 1080 ||
          audios.length !== (hasAudio ? 1 : 0) || audios.some(stream => stream.codecName !== "aac") ||
          output.streams.length !== videos.length + audios.length ||
          !Number.isFinite(output.durationSeconds) || Math.abs(output.durationSeconds - duration) > DURATION_TOLERANCE ||
          output.sizeBytes !== stat.size) failed("Clip output failed media validation.");
      verifyDirectory(directory, false);
      // This fresh, private job directory is never reused and labels never enter paths.
      await fsp.rename(partialPath, finalPath);
      ownedFiles.delete(partialPath);
      ownedFiles.add(finalPath);
      completedBytes += stat.size;
      results.push({ ...range, clipId, durationSeconds: output.durationSeconds, filePath: finalPath, hasAudio,
        contentType: "video/mp4", sizeBytes: stat.size });
    }
    throwIfAborted(signal);
    return results;
  } catch (error) {
    // Only unlink files created by this call; never recursively delete user storage or the source.
    if (directory) {
      verifyDirectory(directory, false);
      await Promise.all([...ownedFiles].map(filename => fsp.unlink(filename).catch(cleanupError => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      })));
      try { await fsp.rmdir(directory); }
      catch (cleanupError) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((cleanupError as NodeJS.ErrnoException).code ?? "")) throw cleanupError; }
    }
    throwIfAborted(signal);
    if (error instanceof ClipError || error instanceof FfmpegUnavailableError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new ClipError("CLIP_FAILED", "Video clipping failed.");
  } finally { activeTasks--; }
}
