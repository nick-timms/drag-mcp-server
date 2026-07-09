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
- `GET /health` — returns `200 {"status":"ok","version":"…"}`. No auth, no rate
  limit. Use it for NGINX / load-balancer / container health checks.
- `OPTIONS` — CORS preflight (permissive; the token is user-supplied per
  request, so `*` origin is acceptable).
- `GET`/`DELETE /mcp` → `405` (stateless mode has no session streams).

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
REDIS_HOST=your-redis-host
REDIS_PORT=6379
MCP_RATE_LIMIT=60
MCP_RATE_WINDOW=60
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now drag-mcp
```

## NGINX

See `deploy/nginx-mcp.conf`. The one non-standard requirement: Streamable HTTP
responses can be **SSE streams**, so the location block needs `proxy_buffering
off;` and a long `proxy_read_timeout`, or streamed responses stall behind NGINX.

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
```

Then the real test: **Claude Desktop → Settings → Connectors → Add custom
connector → paste the URL** → tools appear → "list my DragApp boards".

## Deploy-time decisions to confirm with Breno

1. **NGINX prefix** — stripped (`/`) or kept (`/mcp`)?
2. **Rate-limit numbers** — `MCP_RATE_LIMIT` / `MCP_RATE_WINDOW`.
3. **Fail-open vs fail-closed** on Redis outage (default: fail-open).
4. **`DRAG_API_BASE`** — public edge or an internal VPC address?
