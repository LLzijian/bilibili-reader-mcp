import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMcpHandler } from "./helpers/mcp.js";
import { credentialManager } from "../src/utils/credentials.js";

function hideGlobalCredentialConfig() {
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
}

function getCallToolHandler() {
  return getMcpHandler<
    {
      method: "tools/call";
      jsonrpc: "2.0";
      id: number;
      params: { name: string; arguments?: Record<string, unknown> };
    },
    {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }
  >("tools/call");
}

async function callTool(name: string) {
  const handler = getCallToolHandler();
  return handler({
    method: "tools/call",
    jsonrpc: "2.0",
    id: 1,
    params: { name, arguments: {} },
  });
}

describe("credential MCP tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    credentialManager.clearCredentials();
    delete process.env.BILIBILI_SESSDATA;
    delete process.env.BILIBILI_BILI_JCT;
    delete process.env.BILIBILI_DEDEUSERID;
  });

  it("returns setup instructions as JSON text", async () => {
    const response = await callTool("get_credential_setup_instructions");
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBeUndefined();
    expect(payload.recommended_commands).toContain(
      "video-reader-mcp config",
    );
    expect(payload.security_notes_en.join(" ")).toContain(
      "Do not paste Cookie values",
    );
    expect(payload.security_notes_zh.join(" ")).toContain(
      "不要把 Cookie 值粘贴到 MCP 客户端配置文件中",
    );
    expect(JSON.stringify(payload)).not.toContain("SESSDATA=");
  });

  it("returns safe credential status when credentials are missing", async () => {
    hideGlobalCredentialConfig();

    const response = await callTool("check_bilibili_credentials");
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBeUndefined();
    expect(payload.configured).toBe(false);
    expect(payload.source).toBe("none");
    expect(payload.logged_in).toBe(false);
    expect(payload.next_steps).toContain(
      "Run: video-reader-mcp config",
    );
    expect(payload.next_steps_en).toEqual(payload.next_steps);
    expect(payload.next_steps_zh).toContain(
      "运行：video-reader-mcp config",
    );
  });
});

describe("credential next_steps in error payloads", () => {
  it("credential setup instructions include the exact next_steps used by errors", async () => {
    const response = await callTool("get_credential_setup_instructions");
    const payload = JSON.parse(response.content[0].text);

    expect(payload.recommended_commands).toEqual([
      "video-reader-mcp config",
      "video-reader-mcp check",
    ]);
    expect(payload.security_notes_zh).toContain(
      "不要把 Cookie 值粘贴到 MCP 客户端配置文件中。",
    );
  });
});

describe("package update MCP tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns safe @latest update guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ version: "9.9.9" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await callTool("check_mcp_update");
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBeUndefined();
    expect(payload.latest_version).toBe("9.9.9");
    expect(payload.update_available).toBe(true);
    expect(payload.recommended_mcp_config.command).toBe("node");
    expect(payload.recommended_mcp_config.args[0]).toMatch(/index\.js$/);
    expect(payload.notes_en.join(" ")).toContain("no npm package is published");
    expect(payload.notes_zh.join(" ")).toContain("尚未发布 npm 包");
    expect(JSON.stringify(payload)).not.toContain("SESSDATA=");
  });
});
