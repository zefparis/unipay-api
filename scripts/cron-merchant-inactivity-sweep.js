/**
 * Render Cron job — daily 03:00 UTC
 *
 * Calls POST /v1/internal/merchant-inactivity-sweep to trigger the
 * daily merchant inactivity classification sweep.
 *
 * Auth: x-admin-secret (CRON_SERVICE_SECRET env var — separate from
 * ADMIN_SECRET so cron rotations never break the admin dashboard).
 *
 * Node 18+ native fetch — no dependencies.
 */

const API_URL     = process.env.API_URL      || 'https://unipay-api.onrender.com';
const CRON_SECRET = process.env.CRON_SERVICE_SECRET || process.env.ADMIN_SECRET || '';

if (!CRON_SECRET) {
  console.error('[cron-inactivity-sweep] CRON_SERVICE_SECRET is not set — aborting');
  process.exit(1);
}

const url = `${API_URL}/v1/internal/merchant-inactivity-sweep`;

console.log(`[cron-inactivity-sweep] triggering sweep via ${url}`);

fetch(url, {
  method: 'POST',
  headers: { 'x-admin-secret': CRON_SECRET },
})
  .then((r) => {
    if (!r.ok) {
      return r.json().then((body) => {
        console.error('[cron-inactivity-sweep] non-2xx response:', r.status, JSON.stringify(body));
        process.exit(1);
      });
    }
    return r.json();
  })
  .then((result) => {
    console.log('[cron-inactivity-sweep] sweep completed:', JSON.stringify({
      scanned: result.scanned,
      eligible: result.eligible,
      reminders_sent: result.reminders_sent,
      status_changes: result.status_changes,
      soft_deletes: result.soft_deletes,
      reactivations: result.reactivations,
      errors: result.errors,
    }));
    if (result.errors > 0) {
      console.warn(`[cron-inactivity-sweep] ${result.errors} error(s) occurred during sweep`);
    }
  })
  .catch((err) => {
    console.error('[cron-inactivity-sweep] fetch failed:', err.message);
    process.exit(1);
  });
