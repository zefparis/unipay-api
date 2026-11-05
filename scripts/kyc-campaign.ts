/**
 * Campagne de suspension KYC — exécution réelle (UNE transaction par marchand,
 * un event par marchand, mails Brevo par lots).
 *
 * Règles (plan étape 6) :
 *   a) dossier incomplet (<3 pièces)        → suspended_kyc + mail « incomplet »
 *   b) 3 pièces stockées, non validées      → kyc_required + mail « reçu »
 *   approved + 3 pièces                     → inchangé
 *   tx sur 30 j ou solde ≠ 0                → EXCLU sauf --include-flagged
 *
 * Usage : npx tsx scripts/kyc-campaign.ts            → dry-run (défaut)
 *         npx tsx scripts/kyc-campaign.ts --execute  → réel (après OK)
 */
import { createClient } from '@supabase/supabase-js';
import { sendKycIncompleteEmail, sendKycReceivedEmail } from '../src/services/email.js';

const EXECUTE = process.argv.includes('--execute');
const INCLUDE_FLAGGED = process.argv.includes('--include-flagged');
const BATCH = 10;
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const now = new Date().toISOString();
const ago30 = new Date(Date.now() - 30 * 86400e3).toISOString();

async function main() {
  const { data: merchants, error } = await sb
    .from('merchants')
    .select('id, name, email, mode, kyc_status, rccm_file_url, idnat_file_url, rep_id_file_url')
    .eq('status', 'active')
    .neq('kyc_status', 'approved')
    .is('deleted_at', null);
  if (error) throw error;

  const actions: { id: string; name: string; email: string; target: 'suspended_kyc' | 'kyc_required'; flagged: boolean }[] = [];

  for (const m of merchants ?? []) {
    const docs = [m.rccm_file_url, m.idnat_file_url, m.rep_id_file_url].filter(Boolean).length;
    const target = docs === 3 ? 'kyc_required' : 'suspended_kyc';

    const { count: tx30 } = await sb.from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_id', m.id).gte('created_at', ago30);
    const { data: ledger } = await sb.from('merchant_ledger_entries')
      .select('type, amount').eq('merchant_id', m.id);
    const balance = (ledger ?? []).reduce((s, l) => s + (l.type === 'credit' ? Number(l.amount) : -Number(l.amount)), 0);
    const flagged = (tx30 ?? 0) > 0 || balance !== 0;

    if (flagged && !INCLUDE_FLAGGED) {
      console.log(`SKIP flaggé ${m.name} (tx30=${tx30}, balance=${balance})`);
      continue;
    }
    actions.push({ id: m.id as string, name: m.name as string, email: m.email as string, target, flagged });
  }

  console.log(`\n${EXECUTE ? 'EXECUTION' : 'DRY-RUN'} : ${actions.length} marchands à traiter`);
  const byTarget = { suspended_kyc: 0, kyc_required: 0 };
  for (const a of actions) byTarget[a.target]++;
  console.log(`  a-suspended_kyc: ${byTarget.suspended_kyc} · b-kyc_required: ${byTarget.kyc_required}`);

  if (!EXECUTE) {
    console.log('→ passez --execute pour appliquer (rien modifié)');
    return;
  }

  for (let i = 0; i < actions.length; i += BATCH) {
    const chunk = actions.slice(i, i + BATCH);
    for (const a of chunk) {
      const { error: upErr } = await sb.from('merchants').update({
        access_status: a.target,
        access_status_changed_at: now,
        access_status_reason: a.target === 'suspended_kyc'
          ? 'Dossier de vérification incomplet (campagne conformité)'
          : 'Dossier reçu, en cours de vérification (campagne conformité)',
      }).eq('id', a.id);
      if (upErr) { console.error(`UPDATE KO ${a.id}:`, upErr.message); continue; }

      await sb.from('merchant_kyc_events').insert({
        merchant_id: a.id,
        event: a.target === 'suspended_kyc' ? 'kyc_suspended' : 'kyc_required',
        actor: 'system',
        details: { campaign: 'kyc-compliance-2026-11', flagged: a.flagged },
      });

      try {
        if (a.target === 'suspended_kyc') await sendKycIncompleteEmail(a.email, a.name);
        else await sendKycReceivedEmail(a.email, a.name);
        console.log(`  ${a.target} + mail → ${a.name}`);
      } catch (e) {
        console.error(`  mail KO ${a.name}:`, e);
      }
    }
    if (i + BATCH < actions.length) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('=== campagne terminée ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
