/**
 * Render Cron job — 1st of month, 06:00 UTC
 *
 * Calls POST /v1/admin/dev-expenses/pull-automated for the current month.
 * Auth: x-admin-secret header (ADMIN_SECRET env var — same mechanism as all
 * server-to-server admin calls in this project, no separate CRON_SECRET needed).
 *
 * Node 18+ native fetch — no dependencies.
 */

const API_URL = process.env.API_URL || 'https://unipay-api.onrender.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

if (!ADMIN_SECRET) {
  console.error('[cron] ADMIN_SECRET is not set — aborting');
  process.exit(1);
}

// Build billing_month as YYYY-MM-01 (current month on execution date)
const now = new Date();
const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

const url = `${API_URL}/v1/admin/dev-expenses/pull-automated`;

console.log(`[cron] pulling dev expenses for ${month} via ${url}`);

fetch(url, {
  method: 'POST',
  headers: {
    'x-admin-secret': ADMIN_SECRET,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ month }),
})
  .then((r) => {
    if (!r.ok) {
      return r.json().then((body) => {
        console.error('[cron] pull-automated returned non-2xx:', r.status, JSON.stringify(body));
        process.exit(1);
      });
    }
    return r.json();
  })
  .then((data) => {
    console.log('[cron] pull-automated result:', JSON.stringify(data, null, 2));
    const pulled = data?.pulled?.length ?? 0;
    const failed = data?.failed?.length ?? 0;
    const manual = data?.manual_required?.length ?? 0;
    console.log(`[cron] summary: ${pulled} pulled, ${failed} failed, ${manual} require manual entry`);
    if (failed > 0) {
      console.warn('[cron] some services failed — check API keys in Render env vars');
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('[cron] fetch error:', err.message);
    process.exit(1);
  });
