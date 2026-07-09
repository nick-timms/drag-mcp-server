#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, VERSION } from "./server.js";
import { createRateLimiter } from "./rateLimit.js";

// HTTP entry point for the hosted remote endpoint (app.dragapp.com/mcp).
// Additive to the stdio entry point (src/index.ts) — same 47 tools, same API
// client, same shaping, all reused from the shared core (src/server.ts). The
// only difference is auth: the DragApp token is read per-request from the
// Authorization header rather than a process-wide env var, so one hosted
// process can serve many users, each with their own token.

const PORT = Number(process.env.MCP_PORT) || 3001;
// The path NGINX proxies to this service. We also always accept "/" so it
// works whether NGINX strips the /mcp prefix or passes it through.
const MCP_PATH = process.env.MCP_PATH || "/mcp";

const MISSING_TOKEN_MESSAGE =
  "No DragApp API key provided. Send it in the Authorization header (raw token or 'Bearer <token>'). Get your key from DragApp → Settings → Integrations.";

const rateLimiter = createRateLimiter();

/** Permissive CORS — the token is user-supplied per request (not a cookie), so
 *  any origin is acceptable. Browser MCP clients (e.g. Claude.ai web) preflight. */
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** JSON-RPC error body for transport-level rejections (rate limit, wrong
 *  method). id is null because these are rejected before the request is read. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

/** Extract the DragApp token from the Authorization header. Accepts a raw
 *  token or "Bearer <token>". Never logged. */
function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (bearer ? bearer[1] : trimmed).trim() || undefined;
}

/** Client IP for the unauthenticated rate-limit fallback. Behind NGINX the
 *  socket address is the proxy, so prefer the first X-Forwarded-For hop. */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname === "/";
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
): Promise<void> {
  // Stateless: a fresh Server + transport per request, no session persisted.
  // Token is captured in this closure and used only for this request.
  const server = createMcpServer({
    getToken: () => token,
    missingTokenMessage: MISSING_TOKEN_MESSAGE,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    // Tear down per-request resources once the response is done/aborted.
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  // Let the transport read and parse the request body from the stream.
  await transport.handleRequest(req, res);
}

async function requestHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  setCors(res);

  const method = req.method || "GET";
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  // CORS preflight.
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — no auth, no rate limit.
  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", version: VERSION });
    return;
  }

  if (!isMcpPath(pathname)) {
    sendJson(res, 404, jsonRpcError(-32601, "Not found"));
    return;
  }

  // Stateless mode does not support the GET/DELETE session streams.
  if (method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(
      res,
      405,
      jsonRpcError(-32601, "Method not allowed. Use POST for MCP requests."),
    );
    return;
  }

  const token = extractToken(req);

  // Rate limit BEFORE dispatch. Scope per token (hashed inside the limiter);
  // fall back to client IP for unauthenticated requests.
  const decision = await rateLimiter.check(token ?? `ip:${clientIp(req)}`);
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.resetSeconds));
    sendJson(
      res,
      429,
      jsonRpcError(
        -32029,
        `Rate limit exceeded. Try again in ${decision.resetSeconds}s.`,
      ),
    );
    return;
  }

  await handleMcpPost(req, res, token);
}

const httpServer = createServer((req, res) => {
  // Never let a handler error crash the process or leak internals to the client.
  requestHandler(req, res).catch((err) => {
    console.error("[mcp] request error:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
    } else {
      res.end();
    }
  });
});

httpServer.listen(PORT, () => {
  console.error(
    `DragApp MCP Server v${VERSION} (HTTP) listening on :${PORT} — MCP at ${MCP_PATH} and / , health at /health`,
  );
});

function shutdown(signal: string): void {
  console.error(`[mcp] ${signal} received — shutting down`);
  httpServer.close(() => {
    void rateLimiter.close().finally(() => process.exit(0));
  });
  // Don't hang forever if connections stall.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
