/**
 * Relances KYC J+7 / J+21 (cron x3, ex. quotidien 08:00).
 * Marchands en access_status != 'active' dont la transition date de
 * J+7 ou J+21 → mail de relance + event merchant_kyc_events.
 * Idempotent : un event 'kyc_reminder_j7'/'j21' par marchand et par palier.
 *
 * Usage : npx tsx scripts/kyc-reminders.ts [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import { sendKycIncompleteEmail, sendKycReceivedEmail } from '../src/services/email.js';

const DRY_RUN = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const WINDOWS: { days: number; event: string }[] = [
  { days: 7, event: 'kyc_reminder_j7' },
  { days: 21, event: 'kyc_reminder_j21' },
];

async function main() {
  for (const { days, event } of WINDOWS) {
    const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
    // Marchands bloqués depuis >= N jours
    const { data: merchants } = await sb
      .from('merchants')
      .select('id, name, email, access_status, access_status_changed_at')
      .neq('access_status', 'active')
      .lte('access_status_changed_at', cutoff)
      .is('deleted_at', null);

    for (const m of merchants ?? []) {
      // Déjà relancé à ce palier ?
      const { data: ev } = await sb
        .from('merchant_kyc_events')
        .select('id')
        .eq('merchant_id', m.id)
        .eq('event', event)
        .limit(1);
      if (ev && ev.length > 0) continue;

      console.log(`${DRY_RUN ? '[dry] ' : ''}${event} → ${m.name} <${m.email}> (${m.access_status}, ${m.access_status_changed_at})`);
      if (DRY_RUN) continue;

      if (m.access_status === 'suspended_kyc') {
        await sendKycIncompleteEmail(m.email as string, m.name as string).catch((e) =>
          console.error(`mail KO ${m.id}:`, e));
      } else {
        await sendKycReceivedEmail(m.email as string, m.name as string).catch((e) =>
          console.error(`mail KO ${m.id}:`, e));
      }
      await sb.from('merchant_kyc_events').insert({
        merchant_id: m.id, event, actor: 'system', details: { days },
      });
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
