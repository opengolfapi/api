import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MiddlewareHandler } from 'hono';

export interface ApiKey {
  id: string;
  email: string;
  dailyLimit: number;
  hash: string;
}

export interface KeyAuthEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

export type KeyAuthVariables = {
  apiKey: ApiKey | null;
};

/**
 * SHA-256 hex digest using Web Crypto (available on Cloudflare Workers).
 * Must match the hash format stored in `api_keys.key_hash`.
 */
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function supabase(env: KeyAuthEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

/**
 * Reads `Authorization: Bearer ogapi_xxx`, hashes it, looks it up via
 * `rpc_lookup_api_key`, and stores the result on the Hono context as `apiKey`.
 *
 * - No header → continues anonymously (`apiKey = null`).
 * - Header present but key invalid/revoked → 401.
 */
export function keyAuth(): MiddlewareHandler<{
  Bindings: KeyAuthEnv;
  Variables: KeyAuthVariables;
}> {
  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? c.req.header('authorization');

    if (!auth) {
      c.set('apiKey', null);
      return next();
    }

    const match = /^Bearer\s+(ogapi_[a-f0-9]+)\s*$/i.exec(auth);
    if (!match) {
      c.set('apiKey', null);
      return next();
    }

    const token = match[1];
    const hash = await sha256Hex(token);

    const sb = supabase(c.env);
    const { data, error } = await sb.rpc('rpc_lookup_api_key', { p_key_hash: hash });

    if (error || !data) {
      return c.json({ error: 'Invalid or revoked API key' }, 401);
    }

    // RPC returns jsonb: { id, daily_limit, email } or null
    const row = data as { id: string; daily_limit: number; email: string } | null;
    if (!row || !row.id) {
      return c.json({ error: 'Invalid or revoked API key' }, 401);
    }

    c.set('apiKey', {
      id: row.id,
      email: row.email,
      dailyLimit: row.daily_limit,
      hash,
    });

    return next();
  };
}
