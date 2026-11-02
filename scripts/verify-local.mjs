import { execFileSync } from "node:child_process";
if (!process.env.npm_execpath) throw new Error("Run through npm run verify:local");
const pack = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8", shell: false,
}));
const forbidden = ["harness/", ".harness/", "docs/agent-memory/", "tests/", ".local/"];
const bad = pack[0].files.filter(f => forbidden.some(prefix => f.path.startsWith(prefix)) || f.path.includes("__pycache__/") || /\.py[co]$/.test(f.path));
if (bad.length) throw new Error("包包含非发布文件: " + bad.map(f => f.path).join(", "));
console.log(`package contents OK: ${pack[0].files.length} files`);
