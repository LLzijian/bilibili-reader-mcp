import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsrError } from "../utils/errors.js";

export interface LocalTranscriberConfig { command: string; args: string[] }

// 只读取用户主动指定的本地文件；MCP 输入不能改变执行程序。
export function readLocalTranscriber(
  configFile = process.env.BILIBILI_TRANSCRIBER_CONFIG ?? path.join(os.homedir(), ".bilibili-mcp", "transcriber.json"),
): LocalTranscriberConfig | undefined {
  try {
    const stat = fs.statSync(configFile);
    if (!stat.isFile() || stat.size > 32_768) throw new Error("size");
    const value: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    const config = value as Record<string, unknown>;
    if (Object.keys(config).sort().join(",") !== "args,command" ||
      typeof config.command !== "string" || !path.isAbsolute(config.command) ||
      /[\r\n\0]/.test(config.command) || !fs.statSync(config.command).isFile() ||
      !Array.isArray(config.args) || config.args.length > 32 ||
      !config.args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !/[\r\n\0]/.test(arg)) ||
      !config.args.some((arg: string) => arg.includes("{audio}"))) throw new Error("config");
    return { command: config.command, args: config.args as string[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.BILIBILI_TRANSCRIBER_CONFIG && !fs.existsSync(configFile)) return undefined;
    throw new AsrError("ASR_NOT_READY", "Local transcriber config is invalid. Check command (absolute executable path), args and {audio} in transcriber.json.");
  }
}
