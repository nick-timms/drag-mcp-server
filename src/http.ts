#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ALL_TOOLS, createMcpServer, SERVER_NAME, VERSION } from "./server.js";
import { createRateLimiter } from "./rateLimit.js";
import { createOAuthRouter, DRAG_LOGO, WWW_AUTHENTICATE } from "./oauth.js";

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
  "Authentication required. Your AI client can connect via OAuth (a DragApp connect page will open), or send your DragApp API key in the Authorization header (raw token or 'Bearer <token>'). Get your key from DragApp → Settings → Integrations. Setup guide: https://www.dragapp.com/blog/connect-shared-inbox-to-claude-mcp/";

// Served on GET /mcp from a browser. Kept self-contained (inline styles, no
// assets) so it renders anywhere.
const HINT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Drag MCP Server</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f4f6fb; color: #1a2233; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(20,30,60,.08);
          max-width: 460px; width: 100%; padding: 36px; }
  .brand { display: block; height: 34px; width: auto; margin-bottom: 20px; }
  h1 { font-size: 19px; margin-bottom: 10px; }
  p  { font-size: 14px; line-height: 1.6; color: #4b566b; margin-bottom: 14px; }
  code { background: #eef2f9; border-radius: 6px; padding: 2px 6px; font-size: 13px; }
  a  { color: #4395f8; }
</style>
</head>
<body>
  <main class="card">
    <img class="brand" src="${DRAG_LOGO}" alt="Drag">
    <h1>Drag MCP Server</h1>
    <p>This endpoint connects AI assistants to your DragApp shared inbox —
       emails, WhatsApp, boards, contacts, and analytics, with full read and
       write.</p>
    <p>Add <code>https://app.dragapp.com/mcp</code> as a custom connector in
       Claude, ChatGPT, Cursor, or any client that supports remote MCP —
       you&#39;ll be asked to authorize with your DragApp account.</p>
    <p><a href="https://www.dragapp.com/docs/mcp/">Documentation</a> ·
       <a href="https://www.dragapp.com/blog/connect-shared-inbox-to-claude-mcp/">Setup guide</a></p>
  </main>
</body>
</html>`;

const rateLimiter = createRateLimiter();
const oauth = createOAuthRouter({
  rateLimitByIp: (req) => rateLimiter.check(`ip:${clientIp(req)}`),
});

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

/** Extract the DragApp token from the Authorization header (raw token or
 *  "Bearer <token>"). The header is the ONLY accepted credential location —
 *  keys in URLs end up in edge access logs, so query-parameter auth is not
 *  supported; header-less connector UIs go through OAuth instead. Never
 *  logged. */
function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || header.trim() === "") return undefined;
  const trimmed = header.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  const token = (bearer ? bearer[1] : trimmed).trim();
  return token || undefined;
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
    // Adoption metric: which client (Claude, Cursor, ChatGPT, …) connected.
    // getClientVersion() is only populated by an initialize request, so this
    // logs exactly once per connect — name + version, no content, no PII.
    // (The shared core's oninitialized hook can't see clientInfo here:
    // stateless mode gives the `initialized` notification a fresh Server.)
    const client = server.getClientVersion();
    if (client) {
      console.error(`[mcp] client connected: ${client.name}@${client.version}`);
    }
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
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

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

  // Static server card — a capability descriptor read by directory crawlers
  // (Smithery et al.). Built from the live tool list so it can never drift.
  // Matched by suffix so it works with and without the /mcp prefix.
  if (method === "GET" && pathname.endsWith("/.well-known/mcp/server-card.json")) {
    sendJson(res, 200, {
      serverInfo: { name: SERVER_NAME, version: VERSION },
      authentication: { required: true, schemes: ["oauth2"] },
      tools: ALL_TOOLS,
      resources: [],
      prompts: [],
    });
    return;
  }

  // OAuth: discovery metadata, /register, /authorize, /token.
  if (await oauth.handle(req, res, url, method)) {
    return;
  }

  if (!isMcpPath(pathname)) {
    sendJson(res, 404, jsonRpcError(-32601, "Not found"));
    return;
  }

  // A person (or a directory reviewer) pasting the connector URL into a
  // browser gets a branded hint page instead of a bare JSON error. noindex:
  // the app subdomain must never compete with www.dragapp.com in search.
  if (method === "GET" && (req.headers.accept || "").includes("text/html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HINT_PAGE);
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

  // No credentials → 401 with WWW-Authenticate. This is what triggers the
  // OAuth flow in Claude/ChatGPT/Gemini custom connectors: the client sees
  // the challenge, fetches our discovery metadata, and opens /authorize.
  if (!token) {
    res.setHeader("WWW-Authenticate", WWW_AUTHENTICATE);
    sendJson(res, 401, jsonRpcError(-32001, MISSING_TOKEN_MESSAGE));
    return;
  }

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
    `DragApp MCP Server v${VERSION} (HTTP) listening on :${PORT} — MCP at ${MCP_PATH} and /, OAuth at ${MCP_PATH}/{authorize,token,register} + well-known discovery, health at /health`,
  );
});

function shutdown(signal: string): void {
  console.error(`[mcp] ${signal} received — shutting down`);
  httpServer.close(() => {
    void Promise.allSettled([rateLimiter.close(), oauth.close()]).finally(() =>
      process.exit(0),
    );
  });
  // Don't hang forever if connections stall.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
