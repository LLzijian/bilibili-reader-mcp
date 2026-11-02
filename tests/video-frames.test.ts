import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mock=vi.hoisted(()=>({download:vi.fn(),create:vi.fn(),cleanup:vi.fn(),resolve:vi.fn(),fetch:vi.fn(),spawn:vi.fn()}));
vi.mock("../src/asr/transcription.js",()=>({ASR_TEMP_PREFIX:"bilibili-mcp-asr-",createAsrTempDir:mock.create,cleanupAsrTempDir:mock.cleanup,downloadPlaybackAudio:mock.download,buildAsrRuntimeEnv:()=>({})}));
vi.mock("../src/bilibili/navigation.js",()=>({resolvePartCid:mock.resolve,matchPartIdentity:()=>({page:2,title:"课程第二集"})}));
vi.mock("../src/bilibili/http.js",()=>({fetchWithoutWBI:mock.fetch}));
vi.mock("../src/utils/credentials.js",()=>({credentialManager:{getAuthHeaders:()=>({Cookie:"test-cookie"})}}));
vi.mock("node:child_process",()=>({spawn:mock.spawn}));
import { clearVideoCache, extractVideoFrame, getVideoFrames, parseVideoCandidates, validateFrameTimestamps, MAX_FRAME_BYTES } from "../src/bilibili/frames.js";

const video=(changes: Record<string,unknown>={})=>({id:80,mimeType:"video/mp4",codecs:"avc1.640032",height:1080,bandwidth:100,baseUrl:"https://video.bilivideo.com/video.mp4",...changes});
const jpeg=Buffer.from([255,216,1,255,217]);
beforeEach(()=>{
 vi.clearAllMocks();
 mock.create.mockResolvedValue("/tmp/bilibili-mcp-asr-abcdef");mock.cleanup.mockResolvedValue(undefined);mock.download.mockResolvedValue(undefined);
 mock.resolve.mockResolvedValue({cid:2,pages:[{page:2,cid:2,duration:600}],videoData:{title:"课程",duration:900}});
 mock.fetch.mockResolvedValue({dash:{video:[video()]}});
 mock.spawn.mockImplementation(()=>{const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),kill:vi.fn()});queueMicrotask(()=>{child.stdout.emit("data",jpeg);child.emit("close",0);});return child;});
});
afterEach(async()=>{await clearVideoCache();vi.useRealTimers();});

describe("frame validation and stream selection",()=>{
 it.each([undefined,[],[NaN],[Infinity],[-1],[7200],[1,2,3,4,5],["3"]])("rejects invalid timestamps %#",(input)=>expect(()=>validateFrameTimestamps(input)).toThrow());
 it("selects AVC at up to 1080p and ignores unsafe fallback URLs",()=>{
  const result=parseVideoCandidates({dash:{video:[video({height:2160}),video({height:720,baseUrl:"https://video.bilivideo.com/720"}),video({backupUrl:["https://127.0.0.1/private"]})]}});
  expect(result).toHaveLength(1);expect(result[0].url).toBe("https://video.bilivideo.com/video.mp4");
 });
 it.each([null,{}, {dash:{video:[video({codecs:"hev1"})]}},{dash:{video:[video({baseUrl:"https://evil.test/video"})]}}])("rejects unusable playback %#",(raw)=>expect(()=>parseVideoCandidates(raw)).toThrow());
});

describe("MCP frame reading",()=>{
 it("returns real image content with matching part and time links, and reuses one cached download",async()=>{
  const result=await getVideoFrames("BV1xx411c7mD",[30,120],2);
  expect(result.content.map(c=>c.type)).toEqual(["text","image","text","image"]);
  expect(JSON.parse((result.content[0] as any).text)).toMatchObject({page:2,timestamp_seconds:30,source_url:"https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=30"});
  expect(result.content[1]).toEqual({type:"image",data:jpeg.toString("base64"),mimeType:"image/jpeg"});
  await getVideoFrames("BV1xx411c7mD",[150],2);
  expect(mock.download).toHaveBeenCalledTimes(1);
  expect(mock.download.mock.calls[0][6]).toBe("video");
  expect(mock.spawn.mock.calls[0][1]).toContain("file,pipe");
  expect(mock.spawn.mock.calls[0][2]).toMatchObject({shell:false,windowsHide:true});
 });
 it("validates timestamps and part duration before downloading",async()=>{
  await expect(getVideoFrames("BV1xx411c7mD",[600],2)).rejects.toThrow(/时间点/);
  expect(mock.download).not.toHaveBeenCalled();
 });
 it("cleans failed downloads and allows subsequent requests",async()=>{
  mock.download.mockRejectedValueOnce(Error("download failed"));
  await expect(getVideoFrames("BV1xx411c7mD",[30],2)).rejects.toThrow();
  expect(mock.cleanup).toHaveBeenCalledTimes(1);
  await expect(getVideoFrames("BV1xx411c7mD",[30],2)).resolves.toHaveProperty("content");
 });
 it("rejects already cancelled requests before API access",async()=>{
  await expect(getVideoFrames("BV1xx411c7mD",[30],2,AbortSignal.abort())).rejects.toHaveProperty("name","AbortError");
  expect(mock.resolve).not.toHaveBeenCalled();
 });
 it("does not return blank frames or oversized images",async()=>{
  mock.spawn.mockImplementation(()=>{const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),kill:vi.fn(()=>queueMicrotask(()=>child.emit("close",null)))});queueMicrotask(()=>child.stdout.emit("data",Buffer.alloc(MAX_FRAME_BYTES+1)));return child;});
  await expect(extractVideoFrame("/tmp/video.mp4",1)).rejects.toThrow(/超限/);
 });
 it("reports missing FFmpeg without exposing executable details",async()=>{
  mock.spawn.mockImplementation(()=>{const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),kill:vi.fn()});queueMicrotask(()=>child.emit("error",Error("private path")));return child;});
  await expect(extractVideoFrame("/tmp/video.mp4",1)).rejects.toMatchObject({code:"FFMPEG_UNAVAILABLE"});
 });
});
