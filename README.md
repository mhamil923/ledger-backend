# ledger-backend

Express + Postgres backend for Ledger. Provides auth, watchlist, market data quotes (Finnhub + CoinGecko), and AI analysis (Anthropic). Layers 2–6 have schemas and stub routes; real implementations land as each layer is built.

## Prerequisites

- Node 20+
- Docker Desktop (for local Postgres) or a Neon connection string
- Optional: API keys for Anthropic, Finnhub, CoinGecko (the server still boots without them — endpoints that need them return 503)

## First-time setup

```bash
cd ledger-backend
npm install

cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and JWT_SECRET.
# Generate a JWT secret: openssl rand -base64 48

# Start local Postgres (skip if using Neon)
docker compose up -d

# Apply migrations
npm run migrate

# Create your first user + seed the default watchlist
npm run seed
```

`npm run seed` prompts for an email and password (no hardcoded credentials). It is idempotent — running it again won't reset your password or duplicate watchlist rows. It refuses to run when `NODE_ENV=production`.

## Run the server

```bash
npm run dev          # tsx watch, hot reload
# or
npm run build && npm start
```

Smoke test:
```bash
curl http://localhost:3001/health
# {"ok":true,"service":"ledger-backend"}

curl http://localhost:3001/health/ready
# {"ready":true,"checks":{"database":true,"anthropic":false,"finnhub":false}}
```

## CLI scripts

| Script | Purpose |
|---|---|
| `npm run migrate` | Apply any new SQL migrations from `migrations/`. Tracked in the `_migrations` table; safe to re-run. |
| `npm run seed` | Create the first user (interactive) and seed the default watchlist. Idempotent. |
| `npm run create-user` | Create an additional user (interactive). |
| `npm run change-password` | Change a user's password from the command line (interactive). |

## API surface

### Auth

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | `{ email, password }` | Returns `{ token, user }` |
| POST | `/api/auth/change-password` | Bearer | `{ current_password, new_password }` | Min 12 chars |
| GET  | `/api/auth/me` | Bearer | — | Returns the current user |

### Watchlist (Layer 1)

| Method | Path | Body |
|---|---|---|
| GET | `/api/watchlist?quotes=true` | — |
| POST | `/api/watchlist` | `{ symbol, asset_type, display_name? }` |
| DELETE | `/api/watchlist/:id` | — |
| POST | `/api/watchlist/reorder` | `{ order: [id, id, ...] }` |

`asset_type` is one of `stock`, `crypto`, `etf`. Quotes route through Finnhub (stock/etf) or CoinGecko (crypto). Quotes are cached in-memory for 30s.

### AI analysis (Layer 1)

| Method | Path | Body |
|---|---|---|
| POST | `/api/analysis` | `{ symbol, asset_type, force_refresh?: boolean }` |

Returns a concise daily analysis using Claude. Cached per-user/symbol/day, so repeat requests on the same day are free unless `force_refresh: true`.

### Stubs (Layers 2–6)

`GET /api/portfolio`, `/api/accounts`, `/api/spending`, `/api/bills` — auth-gated, return empty payloads with a `status: "stub"` marker so the app's tabs render.

## Project layout

```
ledger-backend/
├── docker-compose.yml         Local Postgres
├── migrations/                Numbered SQL files (auto-applied by npm run migrate)
├── scripts/
│   ├── migrate.ts             Migration runner (tracked in _migrations table)
│   ├── seed.ts                Interactive first-user + default watchlist
│   ├── create-user.ts         Add another user
│   ├── change-password.ts     CLI password rotation
│   └── lib/prompt.ts          Shared readline helpers
└── src/
    ├── index.ts               Entry point + graceful shutdown
    ├── app.ts                 Express wiring
    ├── config.ts              Zod-validated env loader
    ├── db.ts                  pg pool + transaction helper
    ├── auth/                  bcrypt + JWT + requireAuth middleware
    ├── routes/                One file per feature; stubs.ts holds layer 2-6 placeholders
    └── services/              Finnhub, CoinGecko, Anthropic, unified quotes
```

## Deploying to Elastic Beanstalk

Set env vars in the EB console (not `.env`): `DATABASE_URL` (your Neon connection string), `JWT_SECRET`, `NODE_ENV=production`, `CORS_ORIGIN` (your deployed web app URL), and any of `ANTHROPIC_API_KEY` / `FINNHUB_API_KEY` / `COINGECKO_API_KEY` you want active.

CORS rejects cross-origin requests unless `CORS_ORIGIN` matches the request `Origin` header — set this *before* you deploy the web app or login will fail silently in the browser.

Build before deploy: `npm run build` produces `dist/`. EB Node platform runs `npm start` (which executes `node dist/index.js`).
