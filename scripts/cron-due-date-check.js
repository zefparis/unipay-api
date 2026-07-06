/**
 * Render Cron job — daily 08:00 UTC
 *
 * Calls GET /v1/admin/dev-expenses/upcoming and logs any invoice
 * due within the next 7 days (with emphasis on J+3 or less).
 * Auth: x-admin-secret (ADMIN_SECRET env var).
 *
 * Node 18+ native fetch — no dependencies.
 */

const API_URL      = process.env.API_URL      || 'https://unipay-api.onrender.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

if (!ADMIN_SECRET) {
  console.error('[cron-due-check] ADMIN_SECRET is not set — aborting');
  process.exit(1);
}

const url = `${API_URL}/v1/admin/dev-expenses/upcoming`;

console.log(`[cron-due-check] checking upcoming payments via ${url}`);

fetch(url, {
  headers: { 'x-admin-secret': ADMIN_SECRET },
})
  .then((r) => {
    if (!r.ok) {
      return r.json().then((body) => {
        console.error('[cron-due-check] non-2xx response:', r.status, JSON.stringify(body));
        process.exit(1);
      });
    }
    return r.json();
  })
  .then((data) => {
    const items  = data?.data   ?? [];
    const asOf   = data?.as_of  ?? new Date().toISOString().slice(0, 10);

    if (items.length === 0) {
      console.log(`[cron-due-check] no upcoming payments in the next 7 days (as of ${asOf})`);
      process.exit(0);
    }

    const today = new Date(asOf);

    console.warn(`[cron-due-check] ${items.length} payment(s) due within 7 days (as of ${asOf}):`);

    for (const item of items) {
      const dueDate  = item.due_date ? new Date(item.due_date) : null;
      const daysLeft = dueDate
        ? Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)
        : null;

      const urgency = item.is_overdue
        ? '[OVERDUE]'
        : daysLeft !== null && daysLeft <= 3
          ? '[J+3 IMMINENT]'
          : '[À VENIR]';

      const creditor = item.creditor_name ?? item.category ?? '?';
      const project  = item.project_ref   ? ` | ${item.project_ref}` : '';
      const amount   = `$${Number(item.amount_usd).toFixed(2)}`;
      const due      = item.due_date ?? '—';
      const days     = daysLeft !== null ? ` (J+${daysLeft})` : '';

      console.warn(`[cron-due-check] ${urgency} ${creditor}${project} | ${amount} | échéance: ${due}${days}`);
    }

    process.exit(0);
  })
  .catch((err) => {
    console.error('[cron-due-check] fetch error:', err.message);
    process.exit(1);
  });
