# @opengolfapi/api

Open REST API for the [OpenGolfAPI](https://opengolfapi.org) dataset. Deployed on Cloudflare Workers at [api.opengolfapi.org](https://api.opengolfapi.org).

## Endpoints

- `GET /` — service metadata
- `GET /v1/courses/search?q=<name>&state=<XX>&limit=<N>` — search courses
- `GET /v1/courses/state/:code` — list courses by state
- `GET /v1/courses/:id` — course by id, includes scorecard
- `GET /v1/courses/:id/tees` — all tee sets with ratings, slopes, yardages
- `GET /v1/courses/:id/holes` — full hole-by-hole data
- `GET /v1/courses/:id/climate` — monthly climate normals
- `GET /v1/courses/:id/nearby` — nearby POIs (hotels, restaurants, airports)

## Authenticated requests

Anonymous use works out of the box: 1,000 requests/day per IP, no signup.

For higher limits (10k / 50k / 250k / 1M per day) get a free key in ~30 seconds
at [courses.opengolfapi.org/api-keys](https://courses.opengolfapi.org/api-keys)
and pass it as a Bearer token:

```bash
curl -H "Authorization: Bearer ogapi_xxxxx" \
  https://api.opengolfapi.org/v1/courses?state=CA
```

The API returns standard rate-limit headers on every response:

- `X-RateLimit-Limit` — daily ceiling for this caller
- `X-RateLimit-Remaining` — calls left in the current UTC day
- `X-RateLimit-Reset` — ISO timestamp of the next 00:00 UTC reset

If you exceed the limit you'll get `HTTP 429` with a JSON body explaining the
reset time. Invalid / revoked keys return `HTTP 401`.

## Local dev

```bash
npm install
cp .env.example .dev.vars  # fill in SUPABASE_URL + SUPABASE_ANON_KEY
npm run dev
```

## Deploy

```bash
npm run deploy
```

Set secrets once:
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
```

## Monitoring

Errors and traces can optionally be forwarded to [Sentry](https://sentry.io)
via `@sentry/cloudflare`. The integration is fully opt-in: when `SENTRY_DSN` is
unset the Sentry SDK is disabled and incurs no overhead.

To enable, create a Cloudflare Workers project in your Sentry dashboard, copy
its DSN, and set it as a Worker secret:

```bash
wrangler secret put SENTRY_DSN
# paste DSN like https://<key>@o<org>.ingest.sentry.io/<project>
```

Defaults configured in `src/index.ts`:

- `tracesSampleRate: 0.1` — 10% of requests get a transaction span
- `release: opengolfapi-api@2.0.1`
- Uncaught route errors are tagged with `route` + `method` before re-throwing

## License

MIT
