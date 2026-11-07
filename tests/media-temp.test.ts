import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupMediaTempDir, createMediaTempDir, isRegisteredMediaTempDir } from "../src/media/temp.js";

describe("media temporary ownership", () => {
  it("creates unique registered directories and cleans their contents", async () => {
    const first = await createMediaTempDir();
    const second = await createMediaTempDir();
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(first)).toMatch(/^bilibili-reader-media-/);
    expect(isRegisteredMediaTempDir(first)).toBe(true);
    await fs.writeFile(path.join(first, "media"), "synthetic");
    await cleanupMediaTempDir(first);
    await cleanupMediaTempDir(second);
    expect(isRegisteredMediaTempDir(first)).toBe(false);
    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses root, unregistered prefix matches, and descendants", async () => {
    const dir = await createMediaTempDir();
    try {
      for (const target of [os.tmpdir(), path.join(os.tmpdir(), "bilibili-reader-media-abcdef"), path.join(dir, "child")]) {
        await expect(cleanupMediaTempDir(target)).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED" });
      }
    } finally { await cleanupMediaTempDir(dir); }
  });
  it("refuses a registered directory replaced by a junction", async () => {
    const dir = await createMediaTempDir();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "media-external-"));
    try {
      await fs.rmdir(dir);
      await fs.symlink(other, dir, "junction");
      await expect(cleanupMediaTempDir(dir)).rejects.toMatchObject({ code: "MEDIA_DOWNLOAD_FAILED" });
      expect((await fs.stat(other)).isDirectory()).toBe(true);
    } finally {
      await fs.unlink(dir);
      await cleanupMediaTempDir(dir);
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
