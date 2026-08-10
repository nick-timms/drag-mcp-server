#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, VERSION } from "./server.js";

// stdio entry point (published npm package). Behavior is unchanged from v1:
// the DragApp token is read from the DRAG_API_KEY env var, once per tool call,
// exactly as before. All tool logic and shaping now live in the shared core
// (src/server.ts), which the HTTP entry point (src/http.ts) reuses verbatim.
async function main() {
  const server = createMcpServer({
    getToken: () => process.env.DRAG_API_KEY,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`DragApp MCP Server v${VERSION} running on stdio`);
}

main().catch(console.error);
