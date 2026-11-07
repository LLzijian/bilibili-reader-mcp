import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createAbortError, getOperationSignal, throwIfAborted } from "../security/operation-context.js";
import { FfmpegUnavailableError, MediaError } from "../utils/errors.js";

export function resolveFfmpegPath(): string { return process.env.BILIBILI_FFMPEG_PATH ?? "ffmpeg"; }
export function resolveFfprobePath(): string { return process.env.BILIBILI_FFPROBE_PATH ?? "ffprobe"; }
export interface FfmpegRunOptions { timeoutMs?: number; maxStderrBytes?: number; signal?: AbortSignal; }
export interface ProbeStream { type: "video" | "audio" | "other"; codecName?: string; width?: number; height?: number; }
export interface ProbeResult { durationSeconds: number; sizeBytes: number; streams: ProbeStream[]; formatName?: string; }

function runtimeEnv(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "NO_COLOR", "CUDA_PATH", "LD_LIBRARY_PATH"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
}
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    if (process.platform === "win32") {
      const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:/Windows";
      spawnSync(path.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore", timeout: 5000, env: runtimeEnv() });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Direct-child fallback. */ }
    }
  }
  child.kill("SIGKILL");
}
let activeProcesses = 0;
function run(executable: string, args: readonly string[], options: FfmpegRunOptions, capture: boolean): Promise<{ stderr: string; stdout: string }> {
  const signal = getOperationSignal(options.signal);
  throwIfAborted(signal);
  const timeout = options.timeoutMs ?? 180_000;
  const stderrLimit = options.maxStderrBytes ?? 2048;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(stderrLimit) || stderrLimit < 0 || stderrLimit > 1024 * 1024) {
    throw new MediaError("MEDIA_PROBE_FAILED", "Invalid media process limits.");
  }
  if (activeProcesses >= 4) throw new MediaError("MEDIA_LIMIT_EXCEEDED", "Media subprocess concurrency limit reached.", true);
  activeProcesses++;
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"], env: runtimeEnv() });
    let stderr = Buffer.alloc(0);
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; killTree(child); };
    const onAbort = () => stop(createAbortError());
    const timer = setTimeout(() => stop(new MediaError("MEDIA_PROBE_FAILED", "Media process timed out.", true)), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.stderr?.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-stderrLimit); if (stderrLimit === 0) stderr = Buffer.alloc(0); });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(new MediaError("MEDIA_PROBE_FAILED", "Media probe output exceeded its limit."));
      else stdout.push(Buffer.from(chunk));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup(); reject(failure ?? (error.code === "ENOENT" ? new FfmpegUnavailableError() : new MediaError("MEDIA_PROBE_FAILED", "Media process could not start.")));
    });
    child.once("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new MediaError("MEDIA_PROBE_FAILED", "Media process failed."));
      else resolve({ stderr: stderr.toString("utf8"), stdout: Buffer.concat(stdout).toString("utf8") });
    });
    if (signal?.aborted) onAbort();
  }).finally(() => { activeProcesses--; });
}
export async function runFfmpeg(args: readonly string[], options: FfmpegRunOptions = {}): Promise<{ stderr: string }> {
  const { stderr } = await run(resolveFfmpegPath(), args, options, false);
  return { stderr };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function numeric(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))) throw new Error("numeric");
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error("numeric");
  return result;
}
export async function probeMediaFile(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await run(resolveFfprobePath(), ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", filePath], { signal, timeoutMs: 30_000 }, true);
  try {
    const raw: unknown = JSON.parse(stdout);
    if (!record(raw) || !record(raw.format) || !Array.isArray(raw.streams) || raw.streams.length > 256) throw new Error("shape");
    const durationSeconds = numeric(raw.format.duration);
    const sizeBytes = numeric(raw.format.size);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > 512 * 1024 * 1024) throw new Error("size");
    const streams: ProbeStream[] = raw.streams.map((entry: unknown) => {
      if (!record(entry) || typeof entry.codec_type !== "string") throw new Error("stream");
      const stream: ProbeStream = { type: entry.codec_type === "video" || entry.codec_type === "audio" ? entry.codec_type : "other" };
      if (entry.codec_name !== undefined) {
        if (typeof entry.codec_name !== "string" || entry.codec_name.length > 128) throw new Error("codec");
        stream.codecName = entry.codec_name;
      }
      for (const field of ["width", "height"] as const) {
        if (entry[field] !== undefined) {
          if (typeof entry[field] !== "number" || !Number.isSafeInteger(entry[field]) || (entry[field] as number) <= 0 || (entry[field] as number) > 65536) throw new Error("dimension");
          stream[field] = entry[field] as number;
        }
      }
      return stream;
    });
    const result: ProbeResult = { durationSeconds, sizeBytes, streams };
    if (raw.format.format_name !== undefined) {
      if (typeof raw.format.format_name !== "string" || raw.format.format_name.length > 256) throw new Error("format");
      result.formatName = raw.format.format_name;
    }
    return result;
  } catch { throw new MediaError("MEDIA_PROBE_FAILED", "Media probe returned invalid metadata."); }
}
