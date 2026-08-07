import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Redis from "ioredis";
import type { RateLimitDecision } from "./rateLimit.js";

/**
 * OAuth 2.1 for the hosted MCP endpoint.
 *
 * Why this exists: Claude.ai, ChatGPT, and Gemini custom connectors take a
 * URL only — there is no field for an API key or custom header. The MCP
 * authorization spec covers this: the server answers unauthenticated requests
 * with 401 + WWW-Authenticate pointing at OAuth metadata, the client registers
 * itself (RFC 7591 dynamic registration), opens a browser to /authorize, and
 * exchanges the resulting code at /token (PKCE, RFC 7636). Our /authorize page
 * asks the user for their DragApp API key once, verifies it against the Drag
 * API, and hands it back to the AI client as the OAuth access token.
 *
 * Statelessness is preserved — nothing is stored server-side:
 * - client_id  = base64url(client metadata) + "." + HMAC  (self-validating)
 * - auth code  = AES-256-GCM blob {key, PKCE challenge, redirect_uri, exp}
 * - access token = the user's own DragApp key (we never mint or keep tokens)
 * Redis, when configured, is used only to mark auth codes as used (replay
 * protection); without Redis the short TTL + PKCE binding is the protection.
 *
 * Secrets: MCP_OAUTH_SECRET signs/encrypts the blobs above. All instances
 * behind the same URL must share it. Without it a random per-boot secret is
 * used (fine for a single instance; logins break on restart).
 */

const PUBLIC_URL = (
  process.env.MCP_PUBLIC_URL?.trim() || "https://app.dragapp.com/mcp"
).replace(/\/+$/, "");

const CODE_TTL_MS = 5 * 60 * 1000;
const SCOPE = "dragapp";

const secretSource = process.env.MCP_OAUTH_SECRET;
if (!secretSource) {
  console.error(
    "[mcp] MCP_OAUTH_SECRET not set — using an ephemeral secret. OAuth logins will break on restart and will NOT work across multiple instances. Set it in production (e.g. `openssl rand -hex 32`).",
  );
}
const SECRET = createHash("sha256")
  .update(secretSource || randomBytes(32))
  .digest();

export const WWW_AUTHENTICATE = `Bearer realm="DragApp MCP", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`;

// ── crypto helpers ────────────────────────────────────────────────────

const b64u = (b: Buffer): string => b.toString("base64url");

function hmac(data: string): string {
  return b64u(createHmac("sha256", SECRET).update(data).digest());
}

function encrypt(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SECRET, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

function decrypt(blob: string): Record<string, unknown> | null {
  try {
    const raw = Buffer.from(blob, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", SECRET, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── stateless client registry ─────────────────────────────────────────

interface ClientDoc {
  redirect_uris: string[];
  client_name?: string;
  iat: number;
}

function issueClientId(doc: ClientDoc): string {
  const enc = b64u(Buffer.from(JSON.stringify(doc), "utf8"));
  return `${enc}.${hmac(enc)}`;
}

function parseClientId(clientId: string): ClientDoc | null {
  const dot = clientId.lastIndexOf(".");
  if (dot < 1) return null;
  const enc = clientId.slice(0, dot);
  const sig = Buffer.from(clientId.slice(dot + 1));
  const expected = Buffer.from(hmac(enc));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return null;
  }
  try {
    const doc = JSON.parse(Buffer.from(enc, "base64url").toString("utf8")) as ClientDoc;
    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return null;
    return doc;
  } catch {
    return null;
  }
}

function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    // Any real app scheme is fine (https, loopback http, cursor://, vscode://…)
    // — only script-injection pseudo-schemes are rejected.
    return !["javascript:", "data:", "vbscript:", "file:"].includes(u.protocol);
  } catch {
    return false;
  }
}

// ── auth-code replay protection (best-effort, via Redis when present) ─

function createCodeStore(): { consume: (jti: string) => Promise<boolean>; close: () => Promise<void> } {
  const host = process.env.REDIS_HOST?.trim();
  if (!host) {
    // No Redis → rely on the 5-minute TTL + PKCE binding alone.
    return { consume: async () => true, close: async () => {} };
  }
  const redis = new Redis({
    host,
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", () => {});
  return {
    async consume(jti: string): Promise<boolean> {
      try {
        // SET NX: first caller wins; a second exchange of the same code fails.
        const r = await redis.set(`mcp:oauthcode:${jti}`, "1", "EX", 600, "NX");
        return r === "OK";
      } catch {
        return true; // fail-open, consistent with the rate limiter's default
      }
    },
    async close() {
      await redis.quit().catch(() => {});
    },
  };
}

// ── DragApp key verification ──────────────────────────────────────────

type KeyCheck = "ok" | "invalid" | "unavailable";

/** Verify the pasted key with a cheap Drag API call so bad keys are caught on
 *  the connect page, not on the user's first tool call. Never logged. */
async function verifyKey(key: string): Promise<KeyCheck> {
  const base = (process.env.DRAG_API_BASE?.trim() || "https://app.dragapp.com").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1.18/teamBoard/list`, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    return res.ok ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** expires_in for the token response. DragApp keys are JWTs; surface the real
 *  exp when decodable so clients re-prompt at the right time. */
function tokenExpiresIn(key: string): number {
  const YEAR = 31_536_000;
  try {
    const parts = key.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
      if (typeof payload.exp === "number") {
        const secs = Math.floor(payload.exp - Date.now() / 1000);
        if (secs > 0) return Math.min(secs, YEAR);
      }
    }
  } catch {
    // Not a decodable JWT — fall through.
  }
  return YEAR;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────

function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *",
  });
  res.end(html);
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

// ── discovery metadata ────────────────────────────────────────────────

function protectedResourceMetadata() {
  return {
    resource: PUBLIC_URL,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "DragApp MCP Server",
    resource_documentation: "https://github.com/nick-timms/drag-mcp-server",
  };
}

function authServerMetadata() {
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/authorize`,
    token_endpoint: `${PUBLIC_URL}/token`,
    registration_endpoint: `${PUBLIC_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    service_documentation: "https://github.com/nick-timms/drag-mcp-server",
  };
}

// ── /authorize page ───────────────────────────────────────────────────

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
}

function renderAuthorizePage(clientName: string, params: AuthorizeParams, error?: string): string {
  const hidden = (
    [
      ["response_type", "code"],
      ["client_id", params.client_id],
      ["redirect_uri", params.redirect_uri],
      ["state", params.state],
      ["code_challenge", params.code_challenge],
      ["code_challenge_method", "S256"],
      ["scope", params.scope],
    ] as const
  )
    .map(([n, v]) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect to DragApp</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f4f6fb; color: #1a2233; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(20,30,60,.08);
          max-width: 420px; width: 100%; padding: 36px; }
  .brand { font-weight: 800; font-size: 22px; color: #2563eb; margin-bottom: 18px; }
  h1 { font-size: 19px; margin-bottom: 8px; }
  p  { font-size: 14px; line-height: 1.55; color: #4b566b; margin-bottom: 12px; }
  ol { font-size: 14px; color: #4b566b; margin: 0 0 16px 18px; line-height: 1.7; }
  a  { color: #2563eb; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 11px 12px; font-size: 14px;
          border: 1px solid #cbd5e1; border-radius: 8px; font-family: ui-monospace, monospace; }
  input[type=password]:focus { outline: 2px solid #2563eb; border-color: transparent; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 15px; font-weight: 600;
           color: #fff; background: #2563eb; border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; font-size: 13px;
           padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
  .fine { font-size: 12px; color: #8a94a6; margin-top: 16px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">Drag</div>
    <h1>Connect ${escapeHtml(clientName)} to DragApp</h1>
    <p><strong>${escapeHtml(clientName)}</strong> is requesting access to your DragApp boards, emails, and tools.</p>
    <ol>
      <li>Open <a href="https://app.dragapp.com/settings" target="_blank" rel="noopener">DragApp → Settings</a> → Integrations</li>
      <li>Copy your API key and paste it below</li>
    </ol>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="">
      ${hidden}
      <label for="key">DragApp API key</label>
      <input type="password" id="key" name="key" autocomplete="off" spellcheck="false" required autofocus>
      <button type="submit">Connect</button>
    </form>
    <p class="fine">Your key is verified with DragApp and handed to ${escapeHtml(clientName)} as its access token. The MCP service stores nothing.</p>
  </main>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DragApp — error</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f6fb;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(20,30,60,.08);max-width:420px;padding:36px}
h1{font-size:18px;color:#b91c1c;margin:0 0 10px}p{font-size:14px;color:#4b566b;line-height:1.55;margin:0}</style></head>
<body><main class="card"><h1>Can’t continue</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// ── router ────────────────────────────────────────────────────────────

export interface OAuthRouter {
  /** Returns true if the request was an OAuth route and has been handled. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createOAuthRouter(deps: {
  rateLimitByIp: (req: IncomingMessage) => Promise<RateLimitDecision>;
}): OAuthRouter {
  const codeStore = createCodeStore();

  function validateAuthorizeRequest(q: URLSearchParams):
    | { ok: true; client: ClientDoc; params: AuthorizeParams }
    | { ok: false; html: string }
    | { ok: false; redirect: string } {
    const clientId = q.get("client_id") || "";
    const redirectUri = q.get("redirect_uri") || "";
    const client = parseClientId(clientId);
    if (!client) {
      return { ok: false, html: renderErrorPage("Unknown or invalid client. Ask your AI client to re-add the DragApp connector.") };
    }
    // Never redirect anywhere that wasn't registered — show a page instead.
    if (!client.redirect_uris.includes(redirectUri)) {
      return { ok: false, html: renderErrorPage("The redirect address does not match the one this client registered.") };
    }
    const err = (code: string, desc: string): { ok: false; redirect: string } => {
      const dest = new URL(redirectUri);
      dest.searchParams.set("error", code);
      dest.searchParams.set("error_description", desc);
      const state = q.get("state");
      if (state) dest.searchParams.set("state", state);
      return { ok: false, redirect: dest.toString() };
    };
    if (q.get("response_type") !== "code") {
      return err("unsupported_response_type", "Only response_type=code is supported.");
    }
    const challenge = q.get("code_challenge") || "";
    if (!challenge || (q.get("code_challenge_method") || "S256") !== "S256") {
      return err("invalid_request", "PKCE with S256 is required.");
    }
    return {
      ok: true,
      client,
      params: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: q.get("state") || "",
        code_challenge: challenge,
        scope: q.get("scope") || SCOPE,
      },
    };
  }

  async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const q =
      method === "POST"
        ? new URLSearchParams(await readBody(req).catch(() => ""))
        : url.searchParams;

    const v = validateAuthorizeRequest(q);
    if (!v.ok) {
      if ("redirect" in v) {
        res.writeHead(302, { Location: v.redirect });
        res.end();
      } else {
        sendHtml(res, 400, v.html);
      }
      return;
    }
    const clientName = v.client.client_name?.trim() || "An AI assistant";

    if (method === "GET") {
      sendHtml(res, 200, renderAuthorizePage(clientName, v.params));
      return;
    }

    // POST — the user submitted their key. Throttle by IP: this endpoint calls
    // the Drag API to verify keys, so it must not be a brute-force oracle.
    const decision = await deps.rateLimitByIp(req);
    if (!decision.allowed) {
      sendHtml(res, 429, renderAuthorizePage(clientName, v.params, `Too many attempts. Try again in ${decision.resetSeconds}s.`));
      return;
    }

    const key = (q.get("key") || "").trim();
    if (!key) {
      sendHtml(res, 400, renderAuthorizePage(clientName, v.params, "Please paste your DragApp API key."));
      return;
    }
    const check = await verifyKey(key);
    if (check === "invalid") {
      sendHtml(res, 401, renderAuthorizePage(clientName, v.params, "That API key was rejected by DragApp. Copy it again from Settings → Integrations."));
      return;
    }
    if (check === "unavailable") {
      sendHtml(res, 502, renderAuthorizePage(clientName, v.params, "Couldn’t reach DragApp to verify the key. Please try again."));
      return;
    }

    const code = encrypt({
      t: key,
      c: v.params.code_challenge,
      r: v.params.redirect_uri,
      i: v.params.client_id,
      s: v.params.scope,
      e: Date.now() + CODE_TTL_MS,
      j: b64u(randomBytes(16)),
    });
    const dest = new URL(v.params.redirect_uri);
    dest.searchParams.set("code", code);
    if (v.params.state) dest.searchParams.set("state", v.params.state);
    res.writeHead(302, { Location: dest.toString() });
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decision = await deps.rateLimitByIp(req);
    if (!decision.allowed) {
      sendJson(res, 429, { error: "invalid_request", error_description: "Rate limit exceeded." }, { "Retry-After": String(decision.resetSeconds) });
      return;
    }

    const raw = await readBody(req).catch(() => "");
    let form: URLSearchParams;
    if ((req.headers["content-type"] || "").includes("application/json")) {
      try {
        form = new URLSearchParams(Object.entries(JSON.parse(raw) as Record<string, string>));
      } catch {
        form = new URLSearchParams();
      }
    } else {
      form = new URLSearchParams(raw);
    }

    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    const fail = (status: number, error: string, desc: string): void =>
      sendJson(res, status, { error, error_description: desc }, noStore);

    if (form.get("grant_type") !== "authorization_code") {
      return fail(400, "unsupported_grant_type", "Only authorization_code is supported.");
    }
    const payload = decrypt(form.get("code") || "");
    if (!payload) return fail(400, "invalid_grant", "Authorization code is invalid.");
    if (typeof payload.e !== "number" || Date.now() > payload.e) {
      return fail(400, "invalid_grant", "Authorization code has expired. Please reconnect.");
    }
    const clientId = form.get("client_id");
    if (clientId && clientId !== payload.i) {
      return fail(400, "invalid_grant", "client_id does not match this code.");
    }
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== payload.r) {
      return fail(400, "invalid_grant", "redirect_uri does not match this code.");
    }
    const verifier = form.get("code_verifier") || "";
    const expected = b64u(createHash("sha256").update(verifier).digest());
    if (!verifier || expected !== payload.c) {
      return fail(400, "invalid_grant", "PKCE verification failed.");
    }
    if (!(await codeStore.consume(String(payload.j)))) {
      return fail(400, "invalid_grant", "Authorization code already used. Please reconnect.");
    }

    const key = String(payload.t);
    sendJson(
      res,
      200,
      {
        access_token: key,
        token_type: "Bearer",
        expires_in: tokenExpiresIn(key),
        scope: String(payload.s || SCOPE),
      },
      noStore,
    );
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req).catch(() => "");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON." });
      return;
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || !uris.every(isAcceptableRedirect)) {
      sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of valid URLs." });
      return;
    }
    const doc: ClientDoc = {
      redirect_uris: uris.slice(0, 10),
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : undefined,
      iat: Math.floor(Date.now() / 1000),
    };
    sendJson(res, 201, {
      client_id: issueClientId(doc),
      client_id_issued_at: doc.iat,
      redirect_uris: doc.redirect_uris,
      client_name: doc.client_name,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    });
  }

  return {
    async handle(req, res, url, method): Promise<boolean> {
      const p = url.pathname;

      // Discovery documents. Matched by inclusion so every layout works:
      // root RFC form (/.well-known/oauth-authorization-server/mcp), under-path
      // form (/mcp/.well-known/...), and the prefix-stripped equivalents.
      if (p.includes("/.well-known/oauth-protected-resource")) {
        if (method !== "GET") return false;
        sendJson(res, 200, protectedResourceMetadata());
        return true;
      }
      if (p.includes("/.well-known/oauth-authorization-server") || p.includes("/.well-known/openid-configuration")) {
        if (method !== "GET") return false;
        sendJson(res, 200, authServerMetadata());
        return true;
      }
      if (p.endsWith("/authorize") && (method === "GET" || method === "POST")) {
        await handleAuthorize(req, res, url, method);
        return true;
      }
      if (p.endsWith("/token") && method === "POST") {
        await handleToken(req, res);
        return true;
      }
      if (p.endsWith("/register") && method === "POST") {
        await handleRegister(req, res);
        return true;
      }
      return false;
    },
    close: () => codeStore.close(),
  };
}
