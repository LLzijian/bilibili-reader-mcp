import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpHandler } from "./helpers/mcp.js";
const mock=vi.hoisted(()=>({frames:vi.fn()}));
vi.mock("../src/bilibili/frames.js",async(importOriginal)=>({...await importOriginal<typeof import("../src/bilibili/frames.js")>(),getVideoFrames:mock.frames}));
beforeEach(()=>vi.clearAllMocks());
const call=(args: unknown,signal?: AbortSignal)=>getMcpHandler<any,any>("tools/call")({jsonrpc:"2.0",method:"tools/call",id:1,params:{name:"get_video_frames",arguments:args}},{signal});
describe("frame tool handler",()=>{
 it.each([{bvid_or_url:"bad",timestamps:[1]},{bvid_or_url:"BV1xx411c7mD",timestamps:[]},{bvid_or_url:"BV1xx411c7mD",timestamps:[1],page:0}])("rejects invalid arguments before media access %#",async(args)=>{
  const result=await call(args);expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text).code).toBe("VALIDATION_ERROR");expect(mock.frames).not.toHaveBeenCalled();
 });
 it("returns images without converting them into plain text",async()=>{
  const result={content:[{type:"text",text:'{"timestamp_seconds":30}'},{type:"image",mimeType:"image/jpeg",data:"/9j/2Q=="}]};mock.frames.mockResolvedValueOnce(result);
  const controller=new AbortController();expect(await call({bvid_or_url:"BV1xx411c7mD",timestamps:[30],page:2},controller.signal)).toEqual(result);
  expect(mock.frames).toHaveBeenCalledWith("BV1xx411c7mD",[30],2,controller.signal);
 });
 it("does not expose removed favorites",async()=>{
  const result=await getMcpHandler<any,any>("tools/call")({jsonrpc:"2.0",method:"tools/call",id:1,params:{name:"list_bilibili_favorite_videos",arguments:{}}});expect(result.isError).toBe(true);expect(mock.frames).not.toHaveBeenCalled();
 });
});
