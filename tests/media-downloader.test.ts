import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMediaFile } from "../src/media/downloader.js";
import { createMediaTempDir, cleanupMediaTempDir } from "../src/media/temp.js";
let dir: string;
let target: string;
const url = "https://cdn.example.test/synthetic.mp4";
const response = (body = "media", headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "video/mp4", ...headers } });
beforeEach(async () => { dir = await createMediaTempDir(); target = path.join(dir, "video.mp4"); });
afterEach(async () => { await cleanupMediaTempDir(dir); });
describe("bounded media downloader", () => {
  it("streams and atomically publishes a file", async () => {
    const fetchFn = vi.fn(async () => response("media", { "content-length": "5" }));
    await expect(downloadMediaFile(url, target, { fetchFn, maxBytes: 10 })).resolves.toBe(5);
    expect(await fs.readFile(target, "utf8")).toBe("media"); expect(await fs.readdir(dir)).toEqual(["video.mp4"]);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
  });
  it.each([
    ["content-length", "11", "MEDIA_LIMIT_EXCEEDED"], ["content-length", "-1", "MEDIA_DOWNLOAD_FAILED"],
    ["content-length", "wat", "MEDIA_DOWNLOAD_FAILED"], ["content-type", "text/html", "MEDIA_DOWNLOAD_FAILED"],
  ])("rejects invalid or oversized headers %s=%s", async (key, value, code) => {
    await expect(downloadMediaFile(url, target, { fetchFn: async () => response("media", { [key]: value }), maxBytes: 10 })).rejects.toHaveProperty("code", code);
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("rejects chunked overflow and length mismatch and cleans partials", async () => {
    await expect(downloadMediaFile(url, target, { fetchFn: async () => response("123456"), maxBytes: 5 })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    await expect(downloadMediaFile(url, target, { fetchFn: async () => response("12", { "content-length": "5" }), maxBytes: 5 })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("charges failed responses against a shared byte budget", async () => {
    const budget = { remainingBytes: 8 };
    let pull = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (!pull++) c.enqueue(new Uint8Array(5)); else c.error(new Error("disconnect")); } });
    await expect(downloadMediaFile(url, target, { fetchFn: async () => new Response(body, { headers: { "content-type": "video/mp4" } }), maxBytes: 8, budget })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(budget.remainingBytes).toBe(3);
    await expect(downloadMediaFile(url, target, { fetchFn: async () => response("1234", { "content-length": "4" }), maxBytes: 8, budget })).rejects.toHaveProperty("code", "MEDIA_LIMIT_EXCEEDED");
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("follows at most three redirects and validates each hop", async () => {
    const validateUrl = vi.fn((value: string) => value);
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/second.mp4" } })).mockResolvedValueOnce(response());
    await downloadMediaFile(url, target, { fetchFn, maxBytes: 10, validateUrl });
    expect(validateUrl).toHaveBeenCalledWith("https://cdn.example.test/second.mp4");
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(downloadMediaFile(url, target, { fetchFn: loop, maxBytes: 10 })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(loop).toHaveBeenCalledTimes(4);
  });
  it.each(["http://cdn.example.test/file", "https://user:pass@cdn.example.test/file", "https://cdn.example.test:8443/file"])("refuses unsafe redirects %s", async location => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(downloadMediaFile(url, target, { fetchFn, maxBytes: 10 })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it.each(["Cookie", "AUTHORIZATION", "Proxy-Authorization"])("rejects credential header %s before fetching", async key => {
    const fetchFn = vi.fn();
    await expect(downloadMediaFile(url, target, { fetchFn, maxBytes: 10, headers: { [key]: "secret" } })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("times out even when a fetch mock ignores abort", async () => {
    await expect(downloadMediaFile(url, target, { fetchFn: () => new Promise(() => {}), maxBytes: 10, timeoutMs: 5 })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_TIMEOUT");
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it("cancels a stalled body and removes partial files", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = downloadMediaFile(url, target, { fetchFn: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel }), { headers: { "content-type": "video/mp4" } }), maxBytes: 10, signal: controller.signal });
    await vi.waitFor(async () => expect(await fs.readdir(dir)).toContain("video.mp4.partial"));
    controller.abort(); await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(await fs.readdir(dir)).toEqual([]); expect(cancel).toHaveBeenCalled();
  });
  it("refuses destinations outside a registered directory", async () => {
    const fetchFn = vi.fn();
    await expect(downloadMediaFile(url, path.join(dir, "..", "unowned"), { fetchFn, maxBytes: 10 })).rejects.toHaveProperty("code", "MEDIA_DOWNLOAD_FAILED");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
