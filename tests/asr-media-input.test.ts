import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASR_TEMP_PREFIX, cleanupAsrTempDir, createAsrTempDir, transcribeAudioFile, transcribeVideoPart } from "../src/asr/transcription.js";
import { createMediaTempDir, cleanupMediaTempDir, isRegisteredMediaTempDir } from "../src/media/temp.js";
vi.mock("../src/asr/local-transcriber.js", () => ({ readLocalTranscriber: () => undefined }));
const profile = { device: "cpu", computeType: "int8" } as const;
const result = { language: "en", segments: [{ from: 0, to: 1, content: "synthetic" }] };
function ready() {
  return { getLocalTranscriber: () => undefined, getPaths: () => ({ root: "managed", venv: "managed/venv", model: "managed/model", stateFile: "managed/state.json" }),
    getState: () => ({ kind: "ready" as const, executionProfile: profile, deviceReadiness: "ready" as const, migrationStatus: "completed" as const }), runRuntime: vi.fn(async () => result) };
}
let dir: string;
let audioPath: string;
beforeEach(async () => { dir = await createMediaTempDir(); audioPath = path.join(dir, "audio.m4a"); await fs.writeFile(audioPath, "synthetic audio"); });
afterEach(async () => { await cleanupMediaTempDir(dir); });
describe("ASR on leased local media", () => {
  it("runs the verified managed profile without platform network or removing the caller lease", async () => {
    const dependencies = { ...ready(), getPlayback: vi.fn(), downloadAudio: vi.fn() };
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, dependencies)).resolves.toEqual(result);
    expect(dependencies.runRuntime).toHaveBeenCalledWith(expect.any(String), "managed/model", await fs.realpath(audioPath), profile, undefined);
    expect(dependencies.getPlayback).not.toHaveBeenCalled(); expect(dependencies.downloadAudio).not.toHaveBeenCalled();
    expect(isRegisteredMediaTempDir(dir)).toBe(true); expect(await fs.readFile(audioPath, "utf8")).toBe("synthetic audio");
  });
  it("supports ASR-owned directories too", async () => {
    const asrDir = await createAsrTempDir(ASR_TEMP_PREFIX);
    try {
      const file = path.join(asrDir, "audio.m4a"); await fs.writeFile(file, "synthetic");
      await expect(transcribeAudioFile({ audioPath: file, durationSeconds: 2 }, ready())).resolves.toEqual(result);
    } finally { await cleanupAsrTempDir(asrDir); }
  });
  it("rejects not-ready before invoking a runtime", async () => {
    const dependencies = { ...ready(), getState: () => ({ kind: "not_installed" as const }) };
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, dependencies)).rejects.toHaveProperty("code", "ASR_NOT_READY");
    expect(dependencies.runRuntime).not.toHaveBeenCalled();
  });
  it("uses local-transcriber with placeholder substitution before managed readiness", async () => {
    const runLocalRuntime = vi.fn(async () => result); const getState = vi.fn();
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, { ...ready(), getState,
      getLocalTranscriber: () => ({ command: "local-command", args: ["--audio", "{audio}"] }), runLocalRuntime })).resolves.toEqual(result);
    expect(runLocalRuntime).toHaveBeenCalledWith("local-command", ["--audio", await fs.realpath(audioPath)], { signal: undefined }); expect(getState).not.toHaveBeenCalled();
  });
  it("retains managed legacy migration semantics", async () => {
    const dependencies = { ...ready(), getState: () => ({ kind: "ready" as const, version: 1, modelKey: "small" as const, migrationStatus: "pending" as const, deviceReadiness: "migration_pending" as const }), migrateLegacyState: vi.fn(async () => profile) };
    await transcribeAudioFile({ audioPath, durationSeconds: 2 }, dependencies); expect(dependencies.migrateLegacyState).toHaveBeenCalledOnce();
  });
  it.each([NaN, Infinity, -1, 0, 7201])("rejects invalid duration %s", async durationSeconds => {
    const dependencies = ready();
    await expect(transcribeAudioFile({ audioPath, durationSeconds }, dependencies)).rejects.toHaveProperty("name", "AsrError"); expect(dependencies.runRuntime).not.toHaveBeenCalled();
  });
  it("rejects an existing unregistered file", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "external-asr-"));
    try {
      const file = path.join(external, "audio"); await fs.writeFile(file, "external");
      await expect(transcribeAudioFile({ audioPath: file, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_TRANSCRIPTION_FAILED");
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });
  it("rejects traversal out of the registered root", async () => {
    await expect(transcribeAudioFile({ audioPath: path.join(dir, "..", "audio.m4a"), durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_TRANSCRIPTION_FAILED");
  });
  it("rejects a directory junction escape", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "external-asr-"));
    try {
      await fs.writeFile(path.join(external, "audio"), "external"); await fs.symlink(external, path.join(dir, "linked"), "junction");
      await expect(transcribeAudioFile({ audioPath: path.join(dir, "linked", "audio"), durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_TRANSCRIPTION_FAILED");
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });
  it("rejects a symlinked audio file", async ctx => {
    const link = path.join(dir, "linked-audio");
    try { await fs.symlink(audioPath, link, "file"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { ctx.skip(); return; } throw error; }
    await expect(transcribeAudioFile({ audioPath: link, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_TRANSCRIPTION_FAILED");
  });
  it("rejects missing, empty and oversized files", async () => {
    await expect(transcribeAudioFile({ audioPath: path.join(dir, "missing"), durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_TRANSCRIPTION_FAILED");
    await fs.truncate(audioPath, 0);
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_LIMIT_EXCEEDED");
    await fs.truncate(audioPath, 128 * 1024 * 1024 + 1);
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_LIMIT_EXCEEDED");
  });
  it("shares the ASR_BUSY slot with Bilibili and releases it after completion", async () => {
    let release!: (value: typeof result) => void;
    const runRuntime = vi.fn(() => new Promise<typeof result>(resolve => { release = resolve; }));
    const first = transcribeAudioFile({ audioPath, durationSeconds: 2 }, { ...ready(), runRuntime });
    await vi.waitFor(() => expect(runRuntime).toHaveBeenCalledOnce());
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_BUSY");
    await expect(transcribeVideoPart({ bvid: "BV1xx411c7mD", cid: 1, durationSeconds: 2 }, ready())).rejects.toHaveProperty("code", "ASR_BUSY");
    release(result); await first;
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, ready())).resolves.toEqual(result);
  });
  it("propagates cancellation into runtime while preserving the lease", async () => {
    const controller = new AbortController();
    const runRuntime = vi.fn((_python, _model, _audio, _profile, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
    const first = transcribeAudioFile({ audioPath, durationSeconds: 2 }, { ...ready(), runRuntime }, controller.signal);
    await vi.waitFor(() => expect(runRuntime).toHaveBeenCalledOnce()); controller.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError"); expect(isRegisteredMediaTempDir(dir)).toBe(true);
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, ready())).resolves.toEqual(result);
  });
  it("rejects pre-cancelled calls without runtime work", async () => {
    const dependencies = ready();
    await expect(transcribeAudioFile({ audioPath, durationSeconds: 2 }, dependencies, AbortSignal.abort())).rejects.toHaveProperty("name", "AbortError"); expect(dependencies.runRuntime).not.toHaveBeenCalled();
  });
});
