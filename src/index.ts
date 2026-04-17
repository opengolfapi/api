import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

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

export default app;
