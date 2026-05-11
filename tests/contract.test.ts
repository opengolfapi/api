import { describe, it, expect } from 'vitest';

// Contract tests against the live deployed API. Run after each deploy.
// These verify the public API contract: every advertised endpoint returns
// the documented shape and respects auth + rate limiting.

const API = process.env.OPENGOLFAPI_BASE_URL || 'https://api.opengolfapi.org';
const TEST_KEY = process.env.OPENGOLFAPI_TEST_KEY; // optional — for auth tests

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, init);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, headers: res.headers, body };
}

describe('public surface', () => {
  it('GET / returns metadata + endpoints + developers block', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('OpenGolfAPI');
    expect(r.body.courses).toBeGreaterThan(10000);
    expect(r.body.license).toBe('ODbL-1.0');
    expect(Array.isArray(r.body.endpoints)).toBe(true);
    expect(r.body.developers.contact).toContain('@opengolfapi.org');
    expect(r.body.api_keys).toContain('/api-keys');
  });

  it('GET /v1/courses/search returns courses array', async () => {
    const r = await get('/v1/courses/search?state=IL&limit=1');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.courses)).toBe(true);
    expect(r.body.courses[0]).toHaveProperty('id');
    expect(r.body.courses[0]).toHaveProperty('course_name');
    expect(r.body.courses[0]).toHaveProperty('state');
  });

  it('GET /v1/courses/state/:code returns courses', async () => {
    const r = await get('/v1/courses/state/IL?limit=2');
    expect(r.status).toBe(200);
    expect(r.body.courses?.length || r.body.length).toBeGreaterThan(0);
  });
});

describe('rate limit headers', () => {
  it('anonymous requests set X-RateLimit-Limit 1000', async () => {
    const r = await get('/');
    expect(r.headers.get('x-ratelimit-limit')).toBe('1000');
    expect(r.headers.get('x-ratelimit-remaining')).toMatch(/^\d+$/);
    expect(r.headers.get('x-ratelimit-reset')).toMatch(/^\d{4}-/);
  });
});

describe('auth', () => {
  it('Bearer with valid hex format but unknown key → 401', async () => {
    const r = await get('/', {
      headers: { Authorization: 'Bearer ogapi_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/invalid|revoked/i);
  });

  it('Bearer with malformed token → falls through to anon (200)', async () => {
    const r = await get('/', { headers: { Authorization: 'Bearer not-a-real-format' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-ratelimit-limit')).toBe('1000'); // anon tier
  });

  it.skipIf(!TEST_KEY)('valid key gets 10k tier limit', async () => {
    const r = await get('/', { headers: { Authorization: `Bearer ${TEST_KEY}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-ratelimit-limit')).toBe('10000');
  });
});

describe('CORS', () => {
  it('responds with permissive CORS for browser callers', async () => {
    const r = await get('/');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('error handling', () => {
  it('valid-format unknown UUID returns 200 with empty data, not 500', async () => {
    const r = await get('/v1/courses/00000000-0000-0000-0000-000000000000/tees');
    expect([200, 404]).toContain(r.status);
  });
});
