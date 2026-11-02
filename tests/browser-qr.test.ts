import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock("node:child_process",()=>({spawn:mock.spawn}));
import { openBrowserQr } from "../src/bilibili/browser-qr.js";

describe("local browser QR",()=>{
 it("opens a local SVG page without external resources, then deletes it",async()=>{
  mock.spawn.mockImplementation(()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit("spawn"));return child;});
  const cleanup=await openBrowserQr("https://account.bilibili.com/h5/account-h5/auth/scan-web?test=not-a-login");
  const [command,args,options]=mock.spawn.mock.calls[0];
  const file=fileURLToPath(args.at(-1));
  try {
   const html=await readFile(file,"utf8");
   expect(html).toContain("<svg");expect(html).not.toContain("?test=not-a-login");
   expect(html).not.toMatch(/<script|(?:src|href)=/i);
   expect(options).toMatchObject({shell:false,windowsHide:true});
  } finally {await cleanup();}
  await expect(access(file)).rejects.toThrow();
 });
});
