import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import type { ApiKey, KeyAuthEnv, KeyAuthVariables } from './key-auth';

const ANON_DAILY_LIMIT = 1000;

interface Bucket {
  day: string; // UTC YYYY-MM-DD
  count: number;
}

/**
 * In-memory counter, keyed by `apiKey.id` (when authenticated) or the
 * client IP (anonymous). Resets at 00:00 UTC by comparing the current UTC
 * date string against the bucket's `day`.
 *
 * NOTE: Cloudflare Workers run many isolates, so this is per-isolate and
 * therefore approximate. See README "Rate limit storage" caveat. If we ever
 * need exact global limits we'll move this to Workers KV or a Durable Object.
 */
const buckets = new Map<string, Bucket>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function bumpAndCheck(key: string, limit: number): { allowed: boolean; count: number; resetAt: string } {
  const day = utcDay();
  const existing = buckets.get(key);
  let bucket: Bucket;
  if (!existing || existing.day !== day) {
    bucket = { day, count: 0 };
    buckets.set(key, bucket);
  } else {
    bucket = existing;
  }
  if (bucket.count >= limit) {
    return { allowed: false, count: bucket.count, resetAt: nextResetIso() };
  }
  bucket.count += 1;
  return { allowed: true, count: bucket.count, resetAt: nextResetIso() };
}

function nextResetIso(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'anon'
  );
}

/**
 * Tier-aware rate limiter:
 * - If `c.get('apiKey')` is set → uses `apiKey.dailyLimit`, keyed on `apiKey.id`.
 * - Otherwise → 1000/day per IP.
 *
 * On every successful (non-rate-limited) authenticated request, fires
 * `rpc_record_api_key_hit` fire-and-forget via `c.executionCtx.waitUntil`.
 */
export function rateLimit(): MiddlewareHandler<{
  Bindings: KeyAuthEnv;
  Variables: KeyAuthVariables;
}> {
  return async (c, next) => {
    const apiKey = c.get('apiKey') as ApiKey | null;

    let counterKey: string;
    let limit: number;
    if (apiKey) {
      counterKey = `key:${apiKey.id}`;
      limit = apiKey.dailyLimit;
    } else {
      counterKey = `ip:${clientIp(c)}`;
      limit = ANON_DAILY_LIMIT;
    }

    const { allowed, count, resetAt } = bumpAndCheck(counterKey, limit);

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    c.header('X-RateLimit-Reset', resetAt);

    if (!allowed) {
      return c.json(
        {
          error: 'Daily rate limit exceeded',
          limit,
          resetAt,
          upgrade: apiKey ? null : 'https://courses.opengolfapi.org/api-keys',
        },
        429,
      );
    }

    if (apiKey) {
      const url = c.env.SUPABASE_URL;
      const anon = c.env.SUPABASE_ANON_KEY;
      const hash = apiKey.hash;
      const recordHit = (async () => {
        try {
          const sb = createClient(url, anon);
          await sb.rpc('rpc_record_api_key_hit', { p_key_hash: hash });
        } catch {
          // fire-and-forget: never block the response
        }
      })();
      // Workers: keep the request alive long enough for the RPC to land
      c.executionCtx?.waitUntil?.(recordHit);
    }

    return next();
  };
}
