import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import qrcode from "qrcode-generator";

export async function openBrowserQr(url: string): Promise<() => Promise<void>> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bilibili-reader-qr-"));
  const file = path.join(directory, "login.html");
  const cleanup = async () => { await fs.rm(file, { force: true }); await fs.rmdir(directory); };
  try {
    const qr = qrcode(0, "M");
    qr.addData(url, "Byte"); qr.make();
    await fs.writeFile(file, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>B站扫码登录</title><style>body{background:white;color:#111;text-align:center;font:22px sans-serif;margin:32px}svg{max-width:85vw;height:auto}</style><h1>使用手机 B站 App 扫码</h1>' + qr.createSvgTag({ cellSize: 8, margin: 32 }) + '<p>在手机确认后，回到终端等待完成。</p>', { mode: 0o600 });
    const target = pathToFileURL(file).href;
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:/Windows";
    const command = process.platform === "win32" ? path.join(root, "System32", "rundll32.exe") : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
      child.once("error", reject); child.once("spawn", resolve);
    });
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}
