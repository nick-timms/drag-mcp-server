import { createHash } from "node:crypto";
import Redis from "ioredis";

/**
 * Dedicated rate limiter for the hosted MCP HTTP endpoint.
 *
 * This is a standalone reimplementation of the backend's Redis fixed-window
 * algorithm (INCR + expiry on first hit within a window) — the backend's
 * middleware is entangled with its own request internals and is not cleanly
 * importable, so the same algorithm is reproduced here. Env-var names
 * (REDIS_HOST/REDIS_PORT/REDIS_PASSWORD) match the backend's conventions so a
 * deployment can point at the same Redis.
 *
 * Scope: per DragApp token, keyed on a SHA-256 hash of the token — the raw JWT
 * is never stored in, or used as, a Redis key. Unauthenticated requests fall
 * back to the client IP.
 *
 * Only the HTTP path uses this; the stdio entry point never imports it.
 */

const KEY_PREFIX = "mcp:ratelimit:";

export interface RateLimitDecision {
  allowed: boolean;
  /** Configured max requests per window. */
  limit: number;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

export interface RateLimiter {
  /**
   * Record a hit for `identifier` (a token or IP — hashing/prefixing is
   * handled internally) and decide whether it is allowed. Never throws:
   * on a Redis outage it applies the fail-open/fail-closed policy.
   */
  check(identifier: string): Promise<RateLimitDecision>;
  /** Whether rate limiting is actually active (Redis configured). */
  readonly enabled: boolean;
  close(): Promise<void>;
}

/** Atomic fixed-window counter: INCR, set the window TTL on the first hit,
 *  return the current count and the remaining TTL. Runs server-side so the
 *  increment and expiry can't race. */
const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

/** Hash the identifier so a raw JWT never lands in Redis (or in any log). */
function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build a rate limiter from the environment. If REDIS_HOST is not set, rate
 * limiting is disabled and every request is allowed (a no-op limiter) — this
 * keeps local runs and health checks working without a Redis dependency.
 */
export function createRateLimiter(): RateLimiter {
  const host = process.env.REDIS_HOST?.trim();

  if (!host) {
    console.error(
      "[mcp] REDIS_HOST not set — rate limiting disabled (all requests allowed)",
    );
    return {
      enabled: false,
      async check(): Promise<RateLimitDecision> {
        return { allowed: true, limit: Infinity, remaining: Infinity, resetSeconds: 0 };
      },
      async close() {},
    };
  }

  const limit = parsePositiveInt(process.env.MCP_RATE_LIMIT, 60);
  const windowSeconds = parsePositiveInt(process.env.MCP_RATE_WINDOW, 60);
  const windowMs = windowSeconds * 1000;
  // Fail-open by default: a Redis outage should not take the whole MCP service
  // down. Set MCP_RATE_LIMIT_FAIL_OPEN=false to fail closed instead.
  const failOpen = process.env.MCP_RATE_LIMIT_FAIL_OPEN !== "false";

  const redis = new Redis({
    host,
    port: parsePositiveInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    // Don't queue commands forever when Redis is down — fail fast so the
    // fail-open/closed policy kicks in instead of hanging the request.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });

  // Redis emits 'error' asynchronously; swallow it here (never log the value,
  // which could contain connection detail) so an outage doesn't crash the
  // process. Individual check() calls handle the failure per-request.
  redis.on("error", () => {});

  let warnedOutage = false;

  console.error(
    `[mcp] rate limiting enabled: ${limit} requests / ${windowSeconds}s per token (fail-${failOpen ? "open" : "closed"})`,
  );

  return {
    enabled: true,
    async check(identifier: string): Promise<RateLimitDecision> {
      const key = `${KEY_PREFIX}${hashIdentifier(identifier)}`;
      try {
        const [countRaw, ttlRaw] = (await redis.eval(
          FIXED_WINDOW_LUA,
          1,
          key,
          String(windowMs),
        )) as [number, number];

        const count = Number(countRaw);
        const ttlMs = Number(ttlRaw);
        const resetSeconds = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : windowSeconds;
        const remaining = Math.max(0, limit - count);

        warnedOutage = false;
        return { allowed: count <= limit, limit, remaining, resetSeconds };
      } catch {
        // Redis unreachable / command failed. Apply the configured policy.
        if (!warnedOutage) {
          console.error(
            `[mcp] rate limiter: Redis unavailable — failing ${failOpen ? "open (allowing)" : "closed (blocking)"}`,
          );
          warnedOutage = true;
        }
        return {
          allowed: failOpen,
          limit,
          remaining: failOpen ? limit : 0,
          resetSeconds: windowSeconds,
        };
      }
    },
    async close() {
      await redis.quit().catch(() => {});
    },
  };
}
