#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClientFromToken } from "./auth/jwt.js";
import { boardTools, handleBoardTool } from "./tools/boards.js";
import { emailTools, handleEmailTool } from "./tools/email.js";
import { cardTools, handleCardTool } from "./tools/cards.js";
import { labelTools, handleLabelTool } from "./tools/labels.js";
import { commentTools, handleCommentTool } from "./tools/comments.js";
import { tagTools, handleTagTool } from "./tools/tags.js";
import { taskTools, handleTaskTool } from "./tools/tasks.js";
import { contactTools, handleContactTool } from "./tools/contacts.js";
import { knowledgeTools, handleKnowledgeTool } from "./tools/knowledge.js";
import { analyticsTools, handleAnalyticsTool } from "./tools/analytics.js";
import { automationTools, handleAutomationTool } from "./tools/automations.js";
import { whatsappTools, handleWhatsappTool } from "./tools/whatsapp.js";
import { normaliseError } from "./utils/errors.js";

const ALL_TOOLS = [
  ...boardTools,      // 5 tools
  ...emailTools,      // 8 tools
  ...cardTools,       // 6 tools
  ...labelTools,      // 4 tools
  ...commentTools,    // 2 tools
  ...tagTools,        // 2 tools
  ...taskTools,       // 1 tool
  ...contactTools,    // 3 tools
  ...knowledgeTools,  // 5 tools
  ...analyticsTools,  // 4 tools
  ...automationTools, // 3 tools
  ...whatsappTools,   // 4 tools
];

type ToolHandler = (
  client: ReturnType<typeof createClientFromToken>,
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {};

for (const tool of boardTools) TOOL_HANDLERS[tool.name] = handleBoardTool;
for (const tool of emailTools) TOOL_HANDLERS[tool.name] = handleEmailTool;
for (const tool of cardTools) TOOL_HANDLERS[tool.name] = handleCardTool;
for (const tool of labelTools) TOOL_HANDLERS[tool.name] = handleLabelTool;
for (const tool of commentTools) TOOL_HANDLERS[tool.name] = handleCommentTool;
for (const tool of tagTools) TOOL_HANDLERS[tool.name] = handleTagTool;
for (const tool of taskTools) TOOL_HANDLERS[tool.name] = handleTaskTool;
for (const tool of contactTools) TOOL_HANDLERS[tool.name] = handleContactTool;
for (const tool of knowledgeTools) TOOL_HANDLERS[tool.name] = handleKnowledgeTool;
for (const tool of analyticsTools) TOOL_HANDLERS[tool.name] = handleAnalyticsTool;
for (const tool of automationTools) TOOL_HANDLERS[tool.name] = handleAutomationTool;
for (const tool of whatsappTools) TOOL_HANDLERS[tool.name] = handleWhatsappTool;

const server = new Server(
  {
    name: "dragapp",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: ALL_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Unknown tool: ${name}`, code: 404 }),
        },
      ],
      isError: true,
    };
  }

  const token = process.env.DRAG_API_KEY;
  if (!token) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "DRAG_API_KEY not configured. Get your key from https://app.dragapp.com/settings",
            code: 401,
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    const client = createClientFromToken(token);
    const result = await handler(client, name, args as Record<string, unknown>);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const { error, code } = normaliseError(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error, code }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DragApp MCP Server v0.1.2 running on stdio");
}

main().catch(console.error);
