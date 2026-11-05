/**
 * Campagne de suspension KYC — dry-run par défaut, --execute pour appliquer.
 *
 * Règles (plan étape 6, révisé) :
 *   a) inactif + dossier incomplet (<3 pièces)  → suspended_kyc + mail « incomplet »
 *   b) inactif + 3 pièces non validées          → kyc_required + mail « reçu »
 *   c) actif (tx 30 j ou solde ≠ 0) + dossier   → PRÉAVIS 7 j : access_status reste
 *      incomplet ou non validé                    'active', kyc_deadline = J+7,
 *                                                 event notice_sent + mail préavis
 *   approved                                     → inchangé (skip)
 *   EXCLUDE                                      → aucune action automatique
 *
 * Usage : npx tsx scripts/kyc-campaign.ts            → dry-run
 *         npx tsx scripts/kyc-campaign.ts --execute  → réel (après OK)
 */
import { createClient } from '@supabase/supabase-js';
import {
  sendKycIncompleteEmail, sendKycReceivedEmail, sendKycNoticeEmail,
} from '../src/services/email.js';

const EXECUTE = process.argv.includes('--execute');
const INCLUDE_FLAGGED_SUSPEND = process.argv.includes('--include-flagged-suspend');
const BATCH = 10;
const NOTICE_DAYS = 7;

// Exclusions manuelles — aucune action automatique (statut, mail, bandeau, relance)
const EXCLUDE = new Set([
  '9c3e78bd-2292-47b2-8c01-3328cf55d84f', // Friktune (partenaire PRT-69D5A3E8, dossier hors système)
  '06ada919-15fd-4c34-9f88-3e7e22c4b3dd', // Congo Gaming (entité propriétaire)
  '8a377991-62b9-431d-af5c-f1b1fdc8dfd3', // IA-SOLUTION
  '00009263-dcc5-479d-8928-aa15d25a6f5c', // Ndako
]);

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const now = new Date();
const nowIso = now.toISOString();
const deadline = new Date(now.getTime() + NOTICE_DAYS * 86400e3);
const deadlineFr = deadline.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const ago30 = new Date(now.getTime() - 30 * 86400e3).toISOString();

type Action = {
  id: string; name: string; email: string; mode: string;
  target: 'a' | 'b' | 'c'; flagged: boolean;
};

async function main() {
  const { data: merchants, error } = await sb
    .from('merchants')
    .select('id, name, email, mode, kyc_status, rccm_file_url, idnat_file_url, rep_id_file_url')
    .eq('status', 'active')
    .neq('kyc_status', 'approved')
    .is('deleted_at', null);
  if (error) throw error;

  const actions: Action[] = [];
  let excluded = 0;

  for (const m of merchants ?? []) {
    if (EXCLUDE.has(m.id as string)) { excluded++; continue; }
    const docs = [m.rccm_file_url, m.idnat_file_url, m.rep_id_file_url].filter(Boolean).length;

    const { count: tx30 } = await sb.from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_id', m.id).gte('created_at', ago30);
    const { data: ledger } = await sb.from('merchant_ledger_entries')
      .select('type, amount').eq('merchant_id', m.id);
    const balance = (ledger ?? []).reduce((s, l) => s + (l.type === 'credit' ? Number(l.amount) : -Number(l.amount)), 0);
    const flagged = (tx30 ?? 0) > 0 || balance !== 0;

    if (flagged) {
      // Cas c : actif + dossier incomplet/non validé → préavis
      actions.push({ id: m.id as string, name: m.name as string, email: m.email as string, mode: m.mode as string, target: 'c', flagged: true });
    } else {
      // a ou b — inactifs. Option d'exécuter malgré le flag retirée par défaut.
      const target = docs === 3 ? 'b' : 'a';
      if (flagged && !INCLUDE_FLAGGED_SUSPEND) continue;
      actions.push({ id: m.id as string, name: m.name as string, email: m.email as string, mode: m.mode as string, target, flagged });
    }
  }

  const counts = { a: 0, b: 0, c: 0 };
  for (const a of actions) counts[a.target]++;
  console.log(`\n${EXECUTE ? 'EXECUTION' : 'DRY-RUN'} : ${actions.length} marchands (${excluded} exclus manuellement)`);
  console.log(`  a-suspended_kyc: ${counts.a} · b-kyc_required: ${counts.b} · c-préavis J+7: ${counts.c} (deadline ${deadlineFr})`);
  for (const a of actions) if (a.target === 'c') console.log(`    c: ${a.name} <${a.email}> mode=${a.mode}`);

  if (!EXECUTE) { console.log('→ passez --execute pour appliquer (rien modifié)'); return; }

  for (let i = 0; i < actions.length; i += BATCH) {
    for (const a of actions.slice(i, i + BATCH)) {
      const update = a.target === 'c'
        ? { kyc_deadline: deadline.toISOString() } // access_status reste 'active'
        : {
            access_status: a.target === 'a' ? 'suspended_kyc' : 'kyc_required',
            access_status_changed_at: nowIso,
            access_status_reason: a.target === 'a'
              ? 'Dossier de vérification incomplet (campagne conformité)'
              : 'Dossier reçu, en cours de vérification (campagne conformité)',
          };
      const { error: upErr } = await sb.from('merchants').update(update).eq('id', a.id);
      if (upErr) { console.error(`UPDATE KO ${a.id}:`, upErr.message); continue; }

      await sb.from('merchant_kyc_events').insert({
        merchant_id: a.id,
        event: a.target === 'c' ? 'notice_sent' : a.target === 'a' ? 'kyc_suspended' : 'kyc_required',
        actor: 'system',
        details: { campaign: 'kyc-compliance-2026-11', ...(a.target === 'c' ? { deadline: deadline.toISOString() } : {}) },
      });

      try {
        if (a.target === 'a') await sendKycIncompleteEmail(a.email, a.name);
        else if (a.target === 'b') await sendKycReceivedEmail(a.email, a.name);
        else await sendKycNoticeEmail(a.email, a.name, deadlineFr);
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
