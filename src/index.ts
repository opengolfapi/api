import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS: * is intentional — this is a public open API, no auth cookies
app.use('*', cors({ origin: '*', maxAge: 3600 }));

app.get('/', c => c.json({
  name: 'OpenGolfAPI',
  version: '2.0.0',
  courses: 16908,
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
  ],
  donate: 'https://opencollective.com/opengolfapi',
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
  const { data, error } = await sb
    .from('golf_course_holes')
    .select('*')
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

export default app;
