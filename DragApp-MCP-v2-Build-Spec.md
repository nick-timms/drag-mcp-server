# DragApp MCP Server v2 — Build Spec (Hosted Remote Endpoint)

**For:** Breno + Claude session
**Repo:** github.com/nick-timms/drag-mcp-server (public)
**Goal:** the same MCP server, reachable at `https://app.dragapp.com/mcp`, so users connect with just a URL + their DragApp API key — no Node install, no config files. This is what makes ChatGPT support possible (ChatGPT only connects to remote URLs) and turns Claude setup into "paste a URL."

---

## 1. Context — what exists today (v1)

- `@dragapp/mcp-server@0.1.5` is published on npm and **live on five directories** (Official MCP Registry as `com.dragapp/mcp-server`, mcp.so, Glama, PulseMCP, mcpmarket).
- It is **stdio-only**: the AI client launches it as a local process via `npx`.
- Auth is a **single env var**: the server reads `process.env.DRAG_API_KEY` once — fine for one local user, impossible for a shared hosted server.
- 47 tools across 12 categories. All tool logic calls the Drag API (`/v1.18/...` and `/v2/...`) over HTTPS with the user's JWT in the `Authorization` header.
- The server is **stateless** — no DB, no storage; it's a translation layer over the existing Drag API.

## 2. What v2 is (and is not)

v2 adds a **second entry point** to the same codebase: an HTTP server speaking MCP's **Streamable HTTP** transport. Same 47 tools, same API client, same shaping. The only architectural change: **auth moves from process-wide env var to per-request** — each incoming HTTP request carries the user's DragApp JWT in its `Authorization` header, and that token is used for that request only.

v2 is NOT: a rewrite, a new feature set, OAuth (later), or a replacement for the npm package (which stays for Cursor/Claude Code users).

## 3. Hard constraints — do not break these

1. **The published npm/stdio package must remain byte-for-byte compatible.** It is live on five directories; `npx -y @dragapp/mcp-server` with `DRAG_API_KEY` env must keep working exactly as today. The stdio entry point (`src/index.ts`, bin `dragapp-mcp-server` → `dist/index.js`) stays intact. The HTTP entry point is additive.
2. **No secrets or internal names in the repo.** The repo has guardrails: a pre-commit gitleaks hook, a CI secret-scan on every push/PR, and a `prepublishOnly` tarball guard. The CI scan uses a `FORBIDDEN_TERMS` GitHub secret. Do not weaken or bypass these; if a commit is blocked, the block is correct — fix the content.
3. **Statelessness.** No sessions, no token storage, no user data persisted in the MCP layer. Every request authenticates independently.
4. **Never log tokens.** The JWT must not appear in logs, error messages, or crash dumps.
5. **Version discipline.** Version is read dynamically from package.json at runtime (do not hardcode). Follow the "Release checklist" section in CLAUDE.md for any npm release.

## 4. Architecture (per Breno's decision)

```
AI client (Claude / ChatGPT / etc.)
      │  HTTPS, Authorization: <user's DragApp JWT>
      ▼
app.dragapp.com/mcp   ← NGINX on the existing edge
      │  proxy_pass to the MCP box
      ▼
MCP service — its own EC2 instance in the VPC
(same pattern as backend / pubsub / webapp: separate servers behind paths)
      │  calls Drag API with the request's JWT
      ▼
Drag API (/v1.18, /v2) — base URL configurable (see §7)
```

Rationale: isolates the main backend from AI traffic; independent deploys.

## 5. Code changes

### 5a. Shared dispatch refactor

`src/index.ts` currently builds the tool registry and dispatches with a client created once from the env var. Extract the shared core:

- New module (e.g. `src/server.ts`) exporting:
  - the combined tool list (all 47 tools)
  - `handleToolCall(token: string, name: string, args: Record<string, unknown>)` — creates a `DragClient` from the **given** token and dispatches to the correct handler. Token is a per-call parameter, not ambient state.
- `src/index.ts` (stdio) becomes a thin wrapper: reads `DRAG_API_KEY` from env once (existing behavior) and calls the shared dispatch with it. Zero behavior change for stdio users.

### 5b. HTTP entry point

- New `src/http.ts`: an HTTP server using the MCP SDK's **`StreamableHTTPServerTransport`**, exposing `POST /mcp` (and handling the transport's GET/DELETE if the SDK's session mode requires them — prefer the stateless mode).
  - Check the installed `@modelcontextprotocol/sdk` version supports StreamableHTTPServerTransport; if it predates it, upgrade the SDK deliberately (note it in the commit) and re-run the stdio regression tests after.
- **Per-request auth:** read the `Authorization` header. Accept both a raw token and `Bearer <token>` (strip the prefix). Pass the token into `handleToolCall`. Missing/empty token → return a proper JSON-RPC/MCP error instructing the user to supply their DragApp API key (from DragApp → Settings → Integrations). Invalid token → let the Drag API's 401 propagate as a clean MCP error.
- **Path handling:** NGINX will proxy `app.dragapp.com/mcp` to this service. Make the listen path configurable (`MCP_PATH`, default `/mcp`) OR mount the handler at both `/` and `/mcp` — so it works whether NGINX strips the prefix or passes it through. Confirm with the NGINX config at deploy time.
- **Health check:** add `GET /health` returning 200 + `{ status: "ok", version }` — for NGINX/load-balancer checks and monitoring.
- **CORS:** browser-based MCP clients (e.g. Claude.ai web custom connectors) may preflight. Handle `OPTIONS` and set permissive CORS headers on the MCP endpoint (`Access-Control-Allow-Origin: *`, allow `Authorization` + `Content-Type` headers, allow POST/GET/OPTIONS). The token is user-supplied per request, so `*` origin is acceptable here.
- Port from env: `MCP_PORT` (default 3001). Add `start:http` script to package.json.

### 5c. Rate limiting (dedicated MCP cap, Redis)

Per Breno: a dedicated cap for the MCP service using the **same logic as the backend's Redis rate limiting**.

- First: locate the backend's rate-limit implementation in Dragsters-backend (Redis-backed middleware). Assess whether it's cleanly importable; if it's entangled with backend internals, **reimplement the same algorithm standalone** in this repo (same key structure conventions where sensible).
- Scope the limit **per user token** (hash the token — do not store or key on the raw JWT) and/or per IP as a fallback for unauthenticated requests.
- Configuration via env: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (match the backend's env-var naming conventions), plus `MCP_RATE_LIMIT` / `MCP_RATE_WINDOW` so the actual numbers are a deploy-time decision, not hardcoded.
- **Fail-open decision:** if Redis is unreachable, log a warning and allow requests (fail-open) rather than taking the whole service down — unless Breno prefers fail-closed. Flag this choice in the PR for his sign-off.
- Wire it as middleware in `src/http.ts` at the marked point, before dispatch. It must not apply to the stdio path.

### 5d. Configurable API base URL

The Drag API base is currently hardcoded to `https://app.dragapp.com`. Make it configurable: `DRAG_API_BASE` env var, defaulting to the current value. Inside the VPC, Breno may point it at an internal address to avoid hairpinning through the public edge — his call at deploy time.

## 6. Deployment packaging

Breno hosts on EC2, same operational pattern as the other services. Package to match whatever he runs elsewhere (his call — likely PM2/systemd on the box or Docker):

- If **Docker**: multi-stage Dockerfile (build with dev deps → run with prod deps only), `CMD ["node", "dist/http.js"]`, EXPOSE the port, healthcheck against `/health`.
- If **PM2/systemd**: document the exact commands (`npm ci && npm run build && MCP_PORT=... node dist/http.js`) and provide an ecosystem/service file.
- Either way: a short `DEPLOY.md` in the repo listing every env var (`MCP_PORT`, `MCP_PATH`, `DRAG_API_BASE`, `REDIS_*`, `MCP_RATE_LIMIT`, `MCP_RATE_WINDOW`) with defaults and what each does.

**NGINX note (Breno's side):** Streamable HTTP responses can be **SSE streams** — the location block needs `proxy_buffering off;` (and a long `proxy_read_timeout`) or streamed responses will stall behind NGINX buffering. Standard `proxy_pass` otherwise, same as the other services.

## 7. Verification checklist (before calling it done)

1. `npm run build` + `npx tsc --noEmit` clean.
2. **Stdio regression:** `npx -y @dragapp/mcp-server` from a clean directory (NOT the repo checkout — running it inside the repo triggers a known npx working-directory collision and false-fails) still starts, answers `initialize`, reports the correct version, and executes a tool call with `DRAG_API_KEY` set.
3. **HTTP local:** `node dist/http.js` → curl an MCP `initialize` to `localhost:3001/mcp` with `Authorization: <test JWT>` → correct `serverInfo`; `tools/list` returns 47 tools; one real tool call (e.g. `list_boards`) round-trips against the Drag API.
4. **No-token behavior:** request without Authorization → clean MCP error mentioning the API key, HTTP-appropriate status, no crash, nothing sensitive in the message.
5. **Rate limit:** exceed the configured limit → clean throttle error; confirm Redis keys are hashed tokens, not raw JWTs.
6. **Deployed:** through `app.dragapp.com/mcp` end-to-end — then the real test: **Claude Desktop → Settings → Connectors → Add custom connector → paste the URL** → tools appear → run "list my DragApp boards" with a real key.
7. **Token hygiene:** grep logs produced during testing for `eyJ` — must be zero hits.

## 8. Out of scope for this build (explicitly later)

- OAuth 2.1 / "Connect with Google" (a later UX pass; API-key-in-header is v2's auth).
- `.mcpb` desktop extension.
- Official Claude/ChatGPT connector-directory submissions (they require the remote endpoint to exist first — Nick runs that wave post-deploy, including privacy-policy URL and per-tool annotations those directories require).
- Registry/directory listing updates (Nick's side, post-deploy).

## 9. Post-deploy handoffs (so nothing is dropped)

- **Breno → Nick:** the final public URL, confirmation of the NGINX path behavior (prefix stripped or not), and the rate-limit numbers chosen.
- **Nick then runs:** registry remote entry, Glama Connector tab, Claude/ChatGPT connector submissions, website + blog updates ("What's coming next" → "It's here"; setup collapses to: get key → paste URL → done).
