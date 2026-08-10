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
  .brand { display: block; height: 34px; width: auto; margin-bottom: 20px; }
  h1 { font-size: 19px; margin-bottom: 8px; }
  p  { font-size: 14px; line-height: 1.55; color: #4b566b; margin-bottom: 12px; }
  ol { font-size: 14px; color: #4b566b; margin: 0 0 16px 18px; line-height: 1.7; }
  a  { color: #4395f8; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 11px 12px; font-size: 14px;
          border: 1px solid #cbd5e1; border-radius: 8px; font-family: ui-monospace, monospace; }
  input[type=password]:focus { outline: 2px solid #4395f8; border-color: transparent; }
  input[type=password]::placeholder { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #8a94a6; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 15px; font-weight: 600;
           color: #fff; background: #4395f8; border: 0; border-radius: 8px; cursor: pointer; }
  button:hover { background: #2b7de6; }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; font-size: 13px;
           padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
  .fine { font-size: 12px; color: #8a94a6; margin-top: 16px; }
</style>
</head>
<body>
  <main class="card">
    <img class="brand" src="data:image/png;base64,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" alt="Drag">
    <h1>Connect ${escapeHtml(clientName)} to DragApp</h1>
    <p><strong>${escapeHtml(clientName)}</strong> is requesting access to your DragApp boards, emails, and tools.</p>
    <ol>
      <li>Open <strong>DragApp → Settings</strong> → Integrations</li>
      <li>Copy your API key and paste it below</li>
    </ol>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="">
      ${hidden}
      <label for="key">DragApp API key</label>
      <input type="password" id="key" name="key" placeholder="Your API key" autocomplete="off" spellcheck="false" required autofocus>
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
