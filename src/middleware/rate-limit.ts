import { createClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';
import type { ApiKey, KeyAuthEnv, KeyAuthVariables } from './key-auth';

const ANON_DAILY_LIMIT = 1000;

// Durable Object binding type (env var name `RATE_LIMIT_DO`).
// Each DO id corresponds to a unique counter key — `key:<api_key_id>` for
// authenticated, `ip:<client_ip>` for anonymous. DO state is global, so this
// fixes the per-isolate bypass the May 2026 audit flagged.
export interface RateLimitEnv extends KeyAuthEnv {
  RATE_LIMIT_DO: DurableObjectNamespace;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
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

async function bumpAndCheckDO(
  ns: DurableObjectNamespace,
  counterKey: string,
  limit: number,
): Promise<{ allowed: boolean; count: number; resetAt: string }> {
  // idFromName is a deterministic hash → same logical counter always lands on
  // the same DO instance, so all isolates serialize through it.
  const id = ns.idFromName(`${utcDay()}:${counterKey}`);
  const stub = ns.get(id) as unknown as {
    bumpAndCheck: (limit: number) => Promise<{ allowed: boolean; count: number }>;
  };
  const { allowed, count } = await stub.bumpAndCheck(limit);
  return { allowed, count, resetAt: nextResetIso() };
}

/**
 * Tier-aware rate limiter:
 * - If `c.get('apiKey')` is set → uses `apiKey.dailyLimit`, keyed on `apiKey.id`.
 * - Otherwise → 1000/day per IP.
 *
 * Counters live in Durable Objects (binding RATE_LIMIT_DO). Globally
 * consistent across all isolates and regions.
 *
 * On every successful authenticated request, fires `rpc_record_api_key_hit`
 * fire-and-forget via `c.executionCtx.waitUntil`.
 */
export function rateLimit(): MiddlewareHandler<{
  Bindings: RateLimitEnv;
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

    let result: { allowed: boolean; count: number; resetAt: string };
    try {
      result = await bumpAndCheckDO(c.env.RATE_LIMIT_DO, counterKey, limit);
    } catch (e) {
      // Fail open if DO is unreachable. Production path: we'd rather serve a
      // request than reject everyone if our own infra blips. Sentry will
      // capture this via the global onError handler.
      console.error('rate-limit DO failed', e);
      result = { allowed: true, count: 0, resetAt: nextResetIso() };
    }

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - result.count)));
    c.header('X-RateLimit-Reset', result.resetAt);

    if (!result.allowed) {
      return c.json(
        {
          error: 'Daily rate limit exceeded',
          limit,
          resetAt: result.resetAt,
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
      c.executionCtx?.waitUntil?.(recordHit);
    }

    return next();
  };
}
