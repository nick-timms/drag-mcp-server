import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClientFromToken } from "./auth/jwt.js";
import { DragApiError } from "./api/client.js";
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
import { readFileSync } from "node:fs";

// Read version from package.json at runtime so it can never drift from the
// published version. dist/{index,http}.js sit one level below the package root.
export const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export const SERVER_NAME = "dragapp";

// The combined tool list — all 47 tools across 12 categories. Both the stdio
// entry point (src/index.ts) and the HTTP entry point (src/http.ts) expose
// exactly this list; there is a single source of truth.
export const ALL_TOOLS = [
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

/**
 * Dispatch a single tool call using the given token. The token is a per-call
 * parameter — never ambient state — so the same core serves both the single
 * local user (stdio) and many concurrent remote users (HTTP), each with their
 * own DragApp JWT. Creates a fresh DragClient per call and returns the raw
 * tool result; the caller is responsible for MCP content/error shaping.
 */
export async function handleToolCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new DragApiError(`Unknown tool: ${name}`, 404);
  }
  const client = createClientFromToken(token);
  return handler(client, name, args as Record<string, unknown>);
}

export interface McpServerOptions {
  /**
   * Resolve the DragApp token for the current context. Called per tool
   * invocation. stdio reads it from the environment; HTTP reads it from the
   * request's Authorization header. Returning undefined/empty yields the
   * missing-token error below instead of calling the Drag API.
   */
  getToken: () => string | undefined;
  /** Message shown when getToken() yields no token. Transport-specific. */
  missingTokenMessage?: string;
}

const DEFAULT_MISSING_TOKEN_MESSAGE =
  "DRAG_API_KEY not configured. Get your key from https://app.dragapp.com/settings";

function errorContent(error: string, code: number) {
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

/**
 * Build a configured MCP Server that exposes all tools and dispatches calls
 * through the shared core. Token resolution is injected so the exact same
 * request handling (and error/content shaping) backs both entry points.
 */
export function createMcpServer(opts: McpServerOptions): Server {
  const missingTokenMessage =
    opts.missingTokenMessage ?? DEFAULT_MISSING_TOKEN_MESSAGE;

  const server = new Server(
    {
      name: SERVER_NAME,
      version: VERSION,
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

    const token = opts.getToken();
    if (!token || token.trim() === "") {
      return errorContent(missingTokenMessage, 401);
    }

    try {
      const result = await handleToolCall(
        token,
        name,
        args as Record<string, unknown>,
      );
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
      return errorContent(error, code);
    }
  });

  return server;
}
