import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaError } from "../utils/errors.js";

const prefix = "bilibili-reader-media-";
const directories = new Set<string>();
export async function createMediaTempDir(): Promise<string> {
  const dir = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  directories.add(dir);
  return dir;
}
export function isRegisteredMediaTempDir(candidate: string): boolean {
  return directories.has(path.resolve(candidate));
}
export async function cleanupMediaTempDir(dir: string): Promise<void> {
  const target = path.resolve(dir);
  if (!directories.has(target) || path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith(prefix)) {
    throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Refused unsafe media temporary-directory cleanup.");
  }
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MediaError("MEDIA_DOWNLOAD_FAILED", "Refused unsafe media temporary-directory cleanup.");
    }
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  directories.delete(target);
}
