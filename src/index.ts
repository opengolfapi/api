import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';
import { keyAuth, type KeyAuthVariables } from './middleware/key-auth';
import { rateLimit } from './middleware/rate-limit';

export { RateLimitCounter } from './middleware/rate-limit-do';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  // Optional. When unset, Sentry stays disabled and is a no-op.
  // Set via: wrangler secret put SENTRY_DSN
  SENTRY_DSN?: string;
  // Durable Object namespace (declared in wrangler.toml as RATE_LIMIT_DO)
  RATE_LIMIT_DO: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env; Variables: KeyAuthVariables }>();

// CORS: * is intentional — this is a public open API, no auth cookies
app.use('*', cors({ origin: '*', maxAge: 3600 }));

// Optional Bearer-token auth: anonymous requests still pass through.
// Must run BEFORE the rate limiter so it can read the resolved apiKey.
app.use('*', keyAuth());
app.use('*', rateLimit());

app.get('/', c => c.json({
  name: 'OpenGolfAPI',
  version: '2.0.1',
  courses: 14708,
  license: 'ODbL-1.0',
  docs: 'https://opengolfapi.org',
  endpoints: [
    'GET /v1/courses/search?q=&state=',
    'GET /v1/courses/:id',
    'GET /v1/courses/:id/tees',
    'GET /v1/courses/:id/holes',
    'GET /v1/courses/:id/climate',
    'GET /v1/courses/:id/nearby',
    'GET /v1/courses/state/:code',
    'POST /v1/moments  (open write — submit anonymized golfer moments; free API key required)',
  ],
  donate: 'https://opencollective.com/opengolfapi',
  api_keys: 'https://courses.opengolfapi.org/api-keys',
  pricing: 'https://courses.opengolfapi.org/pricing',
  developers: {
    message: 'Building something on top of OpenGolfAPI? We want to know about it. Tell us what you\'re working on, what data you wish we had, and where the API falls short.',
    contact: 'hello@opengolfapi.org',
    github: 'https://github.com/opengolfapi',
  },
}));

function client(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

app.get('/v1/courses/search', async c => {
  const q = c.req.query('q') ?? '';
  const state = c.req.query('state');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const sb = client(c.env);
  let query = sb.from('golf_courses').select('*').limit(limit);
  if (q) query = query.ilike('course_name', `%${q}%`);
  if (state) query = query.eq('state', state.toUpperCase());
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ count: data?.length ?? 0, courses: data });
});

app.get('/v1/courses/state/:code', async c => {
  const code = c.req.param('code').toUpperCase();
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const sb = client(c.env);
  const { data, error } = await sb
    .from('golf_courses')
    .select('*')
    .eq('state', code)
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ state: code, count: data?.length ?? 0, courses: data });
});

app.get('/v1/courses/:id', async c => {
  const id = c.req.param('id');
  const sb = client(c.env);
  const { data: course, error } = await sb
    .from('golf_courses')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  const { data: holes } = await sb
    .from('golf_course_holes')
    .select('hole_number, par, handicap_index')
    .eq('course_id', id)
    .order('hole_number');
  return c.json({ ...course, scorecard: holes ?? [] });
});

app.get('/v1/courses/:id/tees', async c => {
  const sb = client(c.env);
  const { data, error } = await sb
    .from('golf_course_tees')
    .select('*')
    .eq('course_id', c.req.param('id'))
    .order('total_yardage', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ tees: data });
});

app.get('/v1/courses/:id/holes', async c => {
  const sb = client(c.env);
  // FACTS ONLY (2026-06-21): derived per-hole geometry (routing, green front/center/back,
  // fairway/green polygons, elevation, plays-like, dogleg, landing, tee coords, hazard
  // carries) is gated out until accuracy is validated vs GolfViz + paid-tier metering is
  // built. select('*') was leaking the entire paid OpenGolfGeo layer for free.
  const { data, error } = await sb
    .from('golf_course_holes')
    .select('hole_number, par, handicap_index, yardages, meters')
    .eq('course_id', c.req.param('id'))
    .order('hole_number');
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ holes: data });
});

app.get('/v1/courses/:id/climate', async c => {
  const sb = client(c.env);
  const { data, error } = await sb
    .from('golf_course_climate')
    .select('*')
    .eq('course_id', c.req.param('id'))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

app.get('/v1/courses/:id/nearby', async c => {
  const sb = client(c.env);
  const { data, error } = await sb
    .from('golf_course_nearby')
    .select('*')
    .eq('course_id', c.req.param('id'))
    .order('distance_miles')
    .limit(20);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ nearby: data });
});

app.post('/v1/courses/submit', async c => {
  const body = await c.req.json();
  const sb = client(c.env);

  // Accept single object or array
  const submissions = Array.isArray(body) ? body : [body];

  if (submissions.length > 100) {
    return c.json({ error: 'Max 100 courses per request' }, 400);
  }

  const results = [];
  for (const s of submissions) {
    if (!s.course_name || !s.submitter_email) {
      results.push({ error: 'course_name and submitter_email required', course_name: s.course_name });
      continue;
    }
    const { data, error } = await sb.rpc('rpc_submit_course', {
      p_course_name: s.course_name,
      p_city: s.city || null,
      p_state: s.state || null,
      p_country: s.country || 'US',
      p_address: s.address || null,
      p_postal_code: s.postal_code || null,
      p_latitude: s.latitude || null,
      p_longitude: s.longitude || null,
      p_phone: s.phone || null,
      p_website: s.website || null,
      p_email: s.email || null,
      p_course_type: s.course_type || null,
      p_par_total: s.par_total || null,
      p_holes: s.holes || null,
      p_year_built: s.year_built || null,
      p_architect: s.architect || null,
      p_description: s.description || null,
      p_submitter_email: s.submitter_email,
      p_submitter_name: s.submitter_name || null,
    });
    results.push(data || { error: error?.message });
  }

  return c.json({
    submitted: results.filter((r: { success?: boolean; error?: string }) => r.success).length,
    errors: results.filter((r: { success?: boolean; error?: string }) => r.error).length,
    results,
  });
});

// ── POST /v1/moments — OPEN WRITE: the moment layer's ingestion rail ──
// Any app with a free API key writes anonymized golfer "moments" (breadcrumbs / shots /
// pins / presence / conditions). They land in moment_staging as 'pending' and are
// anonymized at ingest: client_id = the app's key id, NEVER a user identity. Downstream
// AI-approval + aggregation promote accepted moments into the map (1m open / 1cm premium).
// Insert-only via RLS; rate-limited by the global middleware. Devs read value back; the
// inflow builds the planet-scale map. This is the keystone the whole flywheel hangs off.
const MOMENT_TYPES = new Set(['breadcrumb', 'shot', 'pin', 'presence', 'condition', 'tee', 'green']);
const MAX_MOMENT_BATCH = 2000;

app.post('/v1/moments', async c => {
  const apiKey = c.get('apiKey');
  if (!apiKey) return c.json({ error: 'A free API key is required to write moments — https://courses.opengolfapi.org/api-keys' }, 401);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON' }, 400); }
  const raw = Array.isArray(body) ? body : ((body as { moments?: unknown[] })?.moments ?? [body]);
  if (!Array.isArray(raw) || raw.length === 0) return c.json({ error: 'send a moment, an array, or {moments:[...]}' }, 400);
  if (raw.length > MAX_MOMENT_BATCH) return c.json({ error: `max ${MAX_MOMENT_BATCH} moments per request` }, 400);

  const rows: Record<string, unknown>[] = [];
  const rejected: { i: number; reason: string }[] = [];
  (raw as Record<string, unknown>[]).forEach((m, i) => {
    const lat = Number(m?.lat), lng = Number(m?.lng);
    const type = String(m?.moment_type ?? '');
    if (!MOMENT_TYPES.has(type)) { rejected.push({ i, reason: 'bad moment_type' }); return; }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) { rejected.push({ i, reason: 'bad lat/lng' }); return; }
    if (!m?.recorded_at) { rejected.push({ i, reason: 'recorded_at required' }); return; }
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
    // ANONYMIZE: only whitelisted fields; client_id = the app key, never user identity
    rows.push({
      course_id: m.course_id ?? null,
      hole_number: num(m.hole_number),
      moment_type: type,
      lat, lng,
      accuracy_m: num(m.accuracy_m),
      altitude_m: num(m.altitude_m),
      recorded_at: m.recorded_at,
      lie: typeof m.lie === 'string' ? m.lie : null,
      device: typeof m.device === 'string' ? m.device : null,
      client_id: apiKey.id,
      payload: m.payload && typeof m.payload === 'object' ? m.payload : null,
    });
  });

  if (rows.length === 0) return c.json({ accepted: 0, rejected: rejected.length, errors: rejected }, 400);
  const { error } = await client(c.env).from('moment_staging').insert(rows);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ accepted: rows.length, rejected: rejected.length, errors: rejected.slice(0, 20), status: 'pending_review' });
});

// Top-level error handler. Forwards uncaught errors to Sentry (when DSN is
// configured) and re-throws so Cloudflare returns the standard 500 response.
// Sentry.withSentry below also captures unhandled exceptions automatically,
// but Hono's onError lets us tag the request context first.
app.onError((err, c) => {
  Sentry.captureException(err, {
    tags: {
      route: c.req.path,
      method: c.req.method,
    },
  });
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Wrap the Hono app so every fetch is traced and errors are forwarded
// to Sentry. When SENTRY_DSN is unset, `enabled: false` makes the SDK a no-op.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    enabled: !!env.SENTRY_DSN,
    release: 'opengolfapi-api@2.0.1',
  }),
  app,
);
