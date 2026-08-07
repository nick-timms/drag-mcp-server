# Deploying the MCP HTTP endpoint

The npm/stdio package is unchanged — this doc is only about the **hosted HTTP
endpoint** (`app.dragapp.com/mcp`) that lets users connect with just a URL + their
DragApp API key. Same 47 tools, same Drag API client; the only difference is
that auth is read **per request** from the `Authorization` header instead of a
process-wide env var.

Two entry points share one codebase:

| Entry point | Command             | Auth                                   |
| ----------- | ------------------- | -------------------------------------- |
| stdio (npm) | `node dist/index.js`| `DRAG_API_KEY` env var (one local user)|
| HTTP (host) | `node dist/http.js` | `Authorization` header, per request    |

## Endpoints

- `POST /mcp` — the MCP Streamable HTTP endpoint. `/` is also accepted, so it
  works whether NGINX strips the `/mcp` prefix or passes it through.
  Unauthenticated requests get `401` + a `WWW-Authenticate` challenge, which is
  what triggers the OAuth flow in AI clients.
- `GET /health` — returns `200 {"status":"ok","version":"…"}`. No auth, no rate
  limit. Use it for NGINX / load-balancer / container health checks.
- **OAuth** (see the OAuth section below):
  - `GET /mcp/authorize` — hosted "Connect to DragApp" page (user pastes their API key)
  - `POST /mcp/token` — code → access-token exchange (PKCE)
  - `POST /mcp/register` — dynamic client registration (RFC 7591)
  - `GET …/.well-known/oauth-protected-resource`, `…/oauth-authorization-server`,
    `…/openid-configuration` — discovery metadata, served under `/mcp/…` **and**
    expected by some clients at the domain root (NGINX routing required — see below).
- `OPTIONS` — CORS preflight (permissive; the token is user-supplied per
  request, so `*` origin is acceptable).
- `GET /mcp` from a browser → small hint page; `DELETE /mcp` → `405`.

## How users connect (the point of all this)

1. User pastes `https://app.dragapp.com/mcp` into Claude / ChatGPT / Gemini
   custom connectors.
2. The client gets a `401`, discovers the OAuth metadata, registers itself, and
   opens a browser popup to our `/mcp/authorize` page.
3. The user pastes their DragApp API key (from Settings → Integrations) once.
   The key is verified against the Drag API, then handed back to the AI client
   as its OAuth access token via the standard code + PKCE exchange.
4. Every MCP request from then on carries the key in the `Authorization`
   header — exactly the same per-request auth path as before.

Power users can skip OAuth entirely: an `Authorization` header (raw or
`Bearer`) or `?key=` query parameter still authenticates directly.

Everything stays **stateless**: the OAuth client ID is a signed blob, the
authorization code is an encrypted 5-minute blob, and the access token IS the
user's own DragApp key — nothing is stored server-side. Redis, when configured,
adds single-use enforcement for authorization codes (replay protection); with
no Redis, the short TTL + PKCE binding is the protection.

## Environment variables

| Variable                   | Default                     | Purpose |
| -------------------------- | --------------------------- | ------- |
| `MCP_PORT`                 | `3001`                      | Port the HTTP server listens on. |
| `MCP_PATH`                 | `/mcp`                      | Path the MCP handler answers on (`/` always accepted too). |
| `DRAG_API_BASE`            | `https://app.dragapp.com`   | Drag API base URL. Point at an internal VPC address to avoid hairpinning through the public edge. |
| `REDIS_HOST`               | _(unset → limiter off)_     | Redis host for rate limiting. If unset, rate limiting is disabled and all requests are allowed. |
| `REDIS_PORT`               | `6379`                      | Redis port. |
| `REDIS_PASSWORD`           | _(none)_                    | Redis password (optional). |
| `MCP_RATE_LIMIT`           | `60`                        | Max requests per window, per token. |
| `MCP_RATE_WINDOW`          | `60`                        | Rate-limit window, in seconds. |
| `MCP_RATE_LIMIT_FAIL_OPEN` | `true`                      | On a Redis outage: `true` allows requests (fail-open), `false` blocks (fail-closed). |
| `MCP_PUBLIC_URL`           | `https://app.dragapp.com/mcp` | Public base URL used in OAuth discovery metadata and advertised endpoint URLs. |
| `MCP_OAUTH_SECRET`         | _(ephemeral if unset)_      | **Set this in production.** Signs OAuth client IDs and encrypts authorization codes (`openssl rand -hex 32`). Must be identical across all instances; without it, OAuth logins break on every restart. |

`DRAG_API_KEY` is **not** used by the HTTP entry point — tokens arrive per request.

## Rate limiting

- Redis-backed fixed-window counter (INCR + expiry on first hit) — the same
  algorithm the backend uses, reimplemented standalone here.
- Scoped **per DragApp token**, keyed on a SHA-256 hash of the token — the raw
  JWT is never used as, or stored in, a Redis key (or any log). Unauthenticated
  requests fall back to the client IP.
- **Fail-open by default**: if Redis is unreachable the service logs a warning
  and allows requests rather than going down with Redis. Flip with
  `MCP_RATE_LIMIT_FAIL_OPEN=false`. ⚠️ **Deploy-time decision — confirm with Breno.**

## Deploy option A — Docker

```bash
docker build -t dragapp-mcp .
docker run -d --name dragapp-mcp \
  -p 3001:3001 \
  -e MCP_PORT=3001 \
  -e DRAG_API_BASE=https://app.dragapp.com \
  -e REDIS_HOST=your-redis-host -e REDIS_PORT=6379 \
  -e MCP_RATE_LIMIT=60 -e MCP_RATE_WINDOW=60 \
  dragapp-mcp
curl localhost:3001/health
```

Multi-stage build (dev deps → prod-only runtime), non-root user, `HEALTHCHECK`
against `/health`. `CMD` is `node dist/http.js`.

## Deploy option B — PM2

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Stateless, so `instances: "max"` + `exec_mode: "cluster"` is safe if you want to
use all cores. See `ecosystem.config.cjs`.

## Deploy option C — systemd

Files in `deploy/`:

```bash
sudo useradd --system --no-create-home dragmcp        # once
sudo cp -r . /opt/drag-mcp-server && cd /opt/drag-mcp-server
sudo -u dragmcp npm ci && sudo -u dragmcp npm run build
sudo cp deploy/drag-mcp.service /etc/systemd/system/
sudo install -m 600 /dev/stdin /etc/drag-mcp.env <<'EOF'
MCP_PORT=3001
DRAG_API_BASE=https://app.dragapp.com
MCP_PUBLIC_URL=https://app.dragapp.com/mcp
MCP_OAUTH_SECRET=<openssl rand -hex 32>
REDIS_HOST=your-redis-host
REDIS_PORT=6379
MCP_RATE_LIMIT=60
MCP_RATE_WINDOW=60
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now drag-mcp
```

## NGINX

See `deploy/nginx-mcp.conf`. Two non-standard requirements:

1. Streamable HTTP responses can be **SSE streams**, so the location block
   needs `proxy_buffering off;` and a long `proxy_read_timeout`, or streamed
   responses stall behind NGINX.
2. **OAuth discovery routing.** Some clients fetch the RFC well-known documents
   at the **domain root** (`/.well-known/oauth-authorization-server/mcp` etc.),
   which the `/mcp` location does not match. The conf adds three `^~
   /.well-known/oauth-*` / `openid-configuration` locations pointing at the MCP
   upstream. Without them, OAuth works in clients that honor the
   `WWW-Authenticate` hint but breaks in clients that go straight to the root
   well-known paths — add all three.

**Prefix handling** — the service accepts both `/mcp` and `/`, so either NGINX
style works:
- `proxy_pass http://mcp_backend;`  → upstream receives `/mcp` (prefix kept)
- `proxy_pass http://mcp_backend/;` → upstream receives `/` (prefix stripped)

⚠️ **Confirm at deploy time which one your NGINX uses** and report it back
(needed for the registry remote-endpoint entry).

## Verify a deployment

```bash
# 1. Health
curl https://app.dragapp.com/mcp/health   # or the /health you exposed

# 2. initialize (real token in the header)
curl -X POST https://app.dragapp.com/mcp \
  -H "Authorization: Bearer <DRAG_API_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 3. tools/list → 47 tools; 4. a real tool call (e.g. list_boards)

# 5. OAuth discovery (all must return JSON, not 404):
curl https://app.dragapp.com/mcp/.well-known/oauth-protected-resource
curl https://app.dragapp.com/.well-known/oauth-protected-resource/mcp
curl https://app.dragapp.com/.well-known/oauth-authorization-server/mcp

# 6. Unauthenticated POST → 401 with a WWW-Authenticate header:
curl -si -X POST https://app.dragapp.com/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | grep -i "HTTP/\|www-authenticate"

# 7. The connect page renders: open in a browser (expect the DragApp form)
#    https://app.dragapp.com/mcp/authorize?response_type=code&client_id=...&...
#    (easiest to just do step 8 and let the client drive it)
```

Then the real test: **Claude.ai (or Desktop) → Settings → Connectors → Add
custom connector → paste `https://app.dragapp.com/mcp`** → a DragApp connect
page opens → paste your API key → tools appear → "list my DragApp boards".
Repeat in ChatGPT (Settings → Connectors) and Gemini.

## Deploy-time decisions to confirm with Breno

1. **NGINX prefix** — stripped (`/`) or kept (`/mcp`)?
2. **Rate-limit numbers** — `MCP_RATE_LIMIT` / `MCP_RATE_WINDOW`.
3. **Fail-open vs fail-closed** on Redis outage (default: fail-open).
4. **`DRAG_API_BASE`** — public edge or an internal VPC address?
5. **`MCP_OAUTH_SECRET`** — generate once (`openssl rand -hex 32`), store with
   the other service secrets, share across all MCP instances.
