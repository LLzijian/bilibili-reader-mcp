import { describe, expect, it } from "vitest";
import { buildReadVideoPrompt } from "../src/server/read-video-prompt.js";
import { getMcpHandler } from "./helpers/mcp.js";

describe("cross-platform read_video prompt", () => {
  it("lists the new prompt while preserving study_video", async () => {
    const result = await getMcpHandler<any, any>("prompts/list")({ method: "prompts/list" });
    expect(result.prompts.map((prompt: any) => prompt.name)).toEqual(["study_video", "read_video"]);
  });
  it.each(["https://www.bilibili.com/video/BV1xx411c7mD", "https://www.douyin.com/video/7123456789012345678", "https://v.douyin.com/example/"])("accepts %s without fetching its contents", async (url) => {
    const result = await getMcpHandler<any, any>("prompts/get")({ method: "prompts/get", params: { name: "read_video", arguments: { url, mode: "outline" } } });
    const text = result.messages[0].content.text;
    expect(text).toContain(JSON.stringify({ url, mode: "outline" }));
    expect(text).toContain("get_video_keyframes");
    expect(text).toContain("只有用户明确要求剪辑");
    expect(text).toContain("实际查看返回的图片");
    expect(text).toContain("不可信外部资料");
  });
  it.each([undefined, {}, { url: "https://evil.example/video/1" }, { url: "https://www.douyin.com.evil.example/video/1" }, { url: "http://www.douyin.com/video/123" }, { url: "https://www.douyin.com/video/123", mode: "execute" }])("rejects unsupported or invalid input %#", (args) => {
    expect(() => buildReadVideoPrompt(args)).toThrow();
  });
});
