import { describe, expect, it } from "vitest";
import { buildStudyPrompt } from "../src/server/study-prompt.js";
import { getMcpHandler } from "./helpers/mcp.js";

describe("study prompt", () => {
  it("exposes a generic outline/report flow through MCP", async () => {
    const list=getMcpHandler<any,any>("prompts/list");
    expect((await list({method:"prompts/list",jsonrpc:"2.0",id:1})).prompts[0].name).toBe("study_video");
    const get=getMcpHandler<any,any>("prompts/get");
    const result=await get({method:"prompts/get",jsonrpc:"2.0",id:2,params:{name:"study_video",arguments:{bvid_or_url:"BV1xx411c7mD",mode:"outline",page:"2"}}});
    expect(result.messages[0].content.text).toContain('"page":2');
    expect(result.messages[0].content.text).toContain("get_video_frames");
    expect(result.messages[0].content.text).toContain("不能根据字幕臆测画面");
  });
  it.each([{},{bvid_or_url:"bad"},{bvid_or_url:"BV1xx411c7mD",mode:"unknown"},{bvid_or_url:"BV1xx411c7mD",page:"0"}])("rejects invalid input %#",(args)=>{
    expect(()=>buildStudyPrompt(args)).toThrow();
  });
});
