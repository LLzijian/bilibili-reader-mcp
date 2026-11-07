// MCP 服务器定义
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import { logger } from "./utils/logger.js";
import { toolSchemas } from "./server/tool-schemas.js";
import { handleToolCall } from "./server/tool-handlers.js";
import {
  buildGenericErrorPayload,
  toErrorTextContent,
} from "./server/error-response.js";
import { runWithOperationSignal } from "./security/operation-context.js";

import { studyPrompt, buildStudyPrompt } from "./server/study-prompt.js";
import { readVideoPrompt, buildReadVideoPrompt } from "./server/read-video-prompt.js";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

// 创建 MCP 服务器实例
export const server = new Server(
  {
    name: "video-reader-mcp-server",
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// 注册工具列表处理器
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolSchemas,
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [studyPrompt, readVideoPrompt] }));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === studyPrompt.name) return buildStudyPrompt(request.params.arguments);
  if (request.params.name === readVideoPrompt.name) return buildReadVideoPrompt(request.params.arguments);
  throw new Error("Unknown prompt");
});

// 注册工具调用处理器
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  try {
    return await runWithOperationSignal(
      extra?.signal,
      async () => await handleToolCall(
        name,
        args as Record<string, unknown> | undefined,
        extra?.signal,
      ),
    );
  } catch (error) {
    logger.error(
      "Error processing MCP tool",
      { error },
      { type: "mcp-tool-error" },
    );
    return toErrorTextContent(buildGenericErrorPayload(error));
  }
});
