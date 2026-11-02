import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalTranscriber } from "../src/asr/local-transcriber.js";
import { runAsrCommand, transcribeVideoPart } from "../src/asr/transcription.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-asr-test-")); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
const output = JSON.stringify({type:"meta",language:"zh"}) + "\n" + JSON.stringify({type:"segment",start:0,end:1.5,text:"学习内容"}) + "\n" + JSON.stringify({type:"done",count:1}) + "\n";
function configure(value: unknown) {
  const file = path.join(directory, "transcriber.json");
  fs.writeFileSync(file, JSON.stringify(value));
  vi.stubEnv("BILIBILI_TRANSCRIBER_CONFIG", file);
  return file;
}

describe("trusted local ASR configuration", () => {
  it("loads an existing absolute executable and audio placeholder", () => {
    configure({command:process.execPath,args:["-e","adapter({audio})"]});
    expect(readLocalTranscriber()).toEqual({command:process.execPath,args:["-e","adapter({audio})"]});
  });
  it.each([
    {command:"python",args:["{audio}"]},
    {command:process.execPath,args:["no-placeholder"]},
    {command:process.execPath,args:["{audio}\n"]},
    {command:process.execPath,args:["{audio}"],env:{TOKEN:"secret"}},
    {command:process.execPath,args:new Array(33).fill("{audio}")},
  ])("rejects unsafe or malformed config %#", (config) => {
    configure(config);
    expect(() => readLocalTranscriber()).toThrow(/config is invalid/);
  });
  it("does not silently fall back when an explicit config is missing", () => {
    vi.stubEnv("BILIBILI_TRANSCRIBER_CONFIG", path.join(directory,"missing"));
    expect(() => readLocalTranscriber()).toThrow();
  });
  it("rejects oversized config", () => {
    const file = configure({command:process.execPath,args:["{audio}"]});
    fs.writeFileSync(file, " ".repeat(32769));
    expect(() => readLocalTranscriber()).toThrow();
  });
});

describe("bounded local ASR execution", () => {
  it("runs a real process and validates timestamped NDJSON", async () => {
    const result = await runAsrCommand(process.execPath,["-e", "process.stdout.write(" + JSON.stringify(output) + ")"]);
    expect(result).toEqual({language:"zh",segments:[{from:0,to:1.5,content:"学习内容"}]});
  });
  it("does not pass credentials or arbitrary environment secrets to the process", async () => {
    vi.stubEnv("BILIBILI_SESSDATA","private-cookie");
    vi.stubEnv("CUSTOM_SECRET_TOKEN","private-key");
    const code = "if(process.env.BILIBILI_SESSDATA||process.env.CUSTOM_SECRET_TOKEN)process.exit(2);process.stdout.write(" + JSON.stringify(output) + ")";
    await expect(runAsrCommand(process.execPath,["-e",code])).resolves.toHaveProperty("segments");
  });
  it("does not expose raw stderr or invalid model output", async () => {
    await expect(runAsrCommand(process.execPath,["-e","console.error('private-cookie');process.exit(7)"])).rejects.toThrow(/code 7/);
    await expect(runAsrCommand(process.execPath,["-e","console.log('model boot log')"])).rejects.toHaveProperty("code","ASR_OUTPUT_INVALID");
  });
  it("cancels a running process", async () => {
    const controller = new AbortController();
    const task = runAsrCommand(process.execPath,["-e","setInterval(()=>{},1000)"],{signal:controller.signal});
    const assertion = expect(task).rejects.toHaveProperty("name","AbortError");
    controller.abort(); await assertion;
  });
  it("enforces the process deadline", async () => {
    await expect(runAsrCommand(process.execPath,["-e","setInterval(()=>{},1000)"],{timeoutMs:100})).rejects.toHaveProperty("code","ASR_TRANSCRIPTION_TIMEOUT");
  });
  it("selects configured local ASR without requiring managed Whisper state", async () => {
    const runLocalRuntime=vi.fn(async()=>({segments:[{from:0,to:1,content:"本地模型"}]}));
    const getState=vi.fn(()=>{throw Error("Whisper state should not be read");});
    const cleanup=vi.fn(async()=>{});
    const result=await transcribeVideoPart({bvid:"BV1xx411c7mD",cid:1,durationSeconds:20},{
      getLocalTranscriber:()=>({command:process.execPath,args:["adapter.js","{audio}"]}),getState,
      getPlayback:async()=>({candidates:[{url:"https://video.bilivideo.com/audio",mimeType:"audio/mp4",bandwidth:1,representationId:1}]}),
      createTempDir:async()=>directory,removeTempDir:cleanup,downloadAudio:async()=>{},runLocalRuntime,
    });
    expect(result?.segments[0].content).toBe("本地模型");
    expect(getState).not.toHaveBeenCalled();
    expect(runLocalRuntime).toHaveBeenCalledWith(process.execPath,["adapter.js",path.join(directory,"audio.m4a")],{signal:undefined});
    expect(cleanup).toHaveBeenCalledWith(directory);
  });
});
