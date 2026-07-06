# Dev Expenses Tracker

Monthly tracking of dev infrastructure costs (Render, Vercel, Supabase, Cloudflare, Anthropic),
paid by a third party (Benoît/HMH), with transparent reporting sent manually to tekkbridge
via tokenized read-only links.

## Architecture

- **Backend**: `unipay-api` — Fastify routes in `src/routes/admin/dev-expenses.ts`
- **Database**: Supabase (existing project `fwoecsflmpoesvunnmqi`) — tables `dev_expenses` + `dev_expenses_reports`
- **Admin UI**: `unipay-congo` — dashboard admin tab "Dev Expenses"
- **Public report**: `dev-expenses-public` — standalone static site on Netlify
- **Cron**: Render cron job triggers auto-pull on 1st of each month at 06:00 UTC

## Monthly Flow

1. **1st of month, 06:00 UTC** — Render cron job calls `POST /v1/admin/dev-expenses/pull-automated`
   - Pulls Anthropic usage cost via Console API
   - Pulls Vercel team billing via Vercel API
   - Render, Supabase, Cloudflare remain in `pending` status (manual entry required)

2. **Admin logs into unipay-congo dashboard → Dev Expenses tab**
   - Reviews auto-pulled amounts (Anthropic, Vercel)
   - Manually enters amounts for Render, Supabase, Cloudflare (with optional invoice upload)
   - Marks each expense as `paid` when Benoît/HMH pays (with optional payment reference)

3. **Generate report** — once all 5 services are filled and not `pending`:
   - Click "Generate PDF + Share Link"
   - System generates a PDF with service/montant/statut table, total, and comparison vs previous month
   - A unique `share_token` is created — a distinct link per month
   - The share URL is displayed for copy/paste

4. **Manual diffusion to tekkbridge**
   - Copy the generated link (e.g. `https://dev-expenses.netlify.app/report/abc123...`)
   - Send it manually to tekkbridge via your preferred channel
   - Each link is autonomous — no navigation to other months
   - No automated email sending at this stage

## API Keys to Configure

Set these in Render environment variables (or `.env` locally):

| Variable | Description | Where to get it |
|---|---|---|
| `ANTHROPIC_ADMIN_API_KEY` | Anthropic Console API key for usage cost | Anthropic Console → Settings → API Keys |
| `VERCEL_API_TOKEN` | Vercel API token with billing read access | Vercel → Settings → Tokens |
| `VERCEL_TEAM_ID` | Vercel team ID | Vercel → Settings → General → Team ID |
| `DEV_EXPENSES_PUBLIC_ORIGIN` | Netlify public report URL | Default: `https://dev-expenses.netlify.app` |

All other env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_SECRET`) are already
configured in the existing unipay-api project.

## Database Migration

Run the SQL migration in the Supabase SQL editor:

```sql
-- File: supabase/migrations/20260706090000_dev_expenses.sql
```

This creates:
- Table `dev_expenses` (one row per service per month)
- Table `dev_expenses_reports` (one row per month with share_token)
- RLS policies (service_role only)
- Storage bucket `dev-expenses-invoices` (private, signed URLs)
- `updated_at` trigger

## API Endpoints

### Admin (require `x-admin-secret` header)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/admin/dev-expenses/pull-automated` | Pull Anthropic + Vercel costs |
| `POST` | `/v1/admin/dev-expenses` | Manual entry with invoice upload (multipart) |
| `PATCH` | `/v1/admin/dev-expenses/:id/mark-paid` | Mark expense as paid |
| `POST` | `/v1/admin/dev-expenses/generate-report` | Generate PDF + share token |
| `GET` | `/v1/admin/dev-expenses/history` | Paginated monthly history |

### Public (token-protected, rate-limited 20 req/min)

| Method | Path | Description |
|---|---|---|
| `GET` | `/dev-expenses/report/:token` | Read-only report JSON + signed PDF URL |

## Security

- `service_role` key is never exposed to clients
- RLS on both tables: service_role only (no public read)
- The public endpoint checks `share_token` server-side — no direct table access
- Invalid tokens return generic 404 (no month existence leak)
- CORS on the public route is scoped to the Netlify domain only
- Rate limiting: 20 requests/min per IP on the public endpoint
- Each month gets a distinct token (48-char hex from `gen_random_bytes(24)`)
- No master token — links are individual and autonomous

## Netlify Deployment (Public Report Page)

1. Go to [app.netlify.com](https://app.netlify.com) → Add new site → Deploy manually
2. Drag the `dev-expenses-public` folder
3. Or connect via Git for continuous deployment
4. Set the custom domain (optional) and update `DEV_EXPENSES_PUBLIC_ORIGIN` in Render

The `netlify.toml` handles the SPA redirect so `/report/:token` serves `index.html`.
