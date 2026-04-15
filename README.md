# @opengolfapi/api

Free REST API for the [OpenGolfAPI](https://opengolfapi.org) dataset. Deployed on Cloudflare Workers at [api.opengolfapi.org](https://api.opengolfapi.org).

## Endpoints

- `GET /` — service metadata
- `GET /v1/courses/search?q=<name>&state=<XX>&limit=<N>` — search courses
- `GET /v1/courses/state/:code` — list courses by state
- `GET /v1/courses/:id` — course by id, includes scorecard

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

## Premium data

Tee ratings, slopes, climate, real-time weather, nearby POIs, and booking links are available via **[GolfAGI](https://golfagi.com)**.

## License

MIT
