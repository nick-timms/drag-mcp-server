import type { RedisOptions } from "ioredis";

/**
 * Shared Redis connection settings for the two places the HTTP entry point
 * talks to Redis: the rate limiter and the OAuth code store.
 *
 * The env-var names match the conventions used by the rest of the platform, so
 * a deployment can copy the same values it already uses elsewhere:
 *
 *   REDIS_HOST      hostname (caller checks this is set before calling)
 *   REDIS_PORT      default 6379
 *   REDIS_PASSWORD  optional; required when the server enforces AUTH
 *   REDIS_DATABASE  logical database index, default 0
 *   REDIS_TLS       "1" to connect over TLS
 *
 * REDIS_TLS matters: a managed Redis with encryption in transit enabled
 * refuses plaintext connections outright, which surfaces only as a generic
 * connection failure. It defaults off so an unencrypted server keeps working
 * with no config change.
 */
export function redisConnectionOptions(host: string): RedisOptions {
  const port = Number(process.env.REDIS_PORT) || 6379;
  const db = Number(process.env.REDIS_DATABASE) || 0;
  return {
    host,
    port,
    password: process.env.REDIS_PASSWORD || undefined,
    db,
    tls: process.env.REDIS_TLS === "1" ? {} : undefined,
    connectTimeout: 10000,
  };
}
