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
 * Garde-fous :
 *   - mail envoyé AVANT tout changement en base ; statut modifié seulement
 *     si Brevo renvoie un messageId ;
 *   - un événement taggé campaign=kyc-compliance-2026-11 est inséré par
 *     marchand traité ; les marchands déjà taggés sont exclus (relance sûre) ;
 *   - les adresses présentes dans la blocklist SMTP Brevo sont exclues.
 *
 * Usage : npx tsx scripts/kyc-campaign.ts            → dry-run
 *         npx tsx scripts/kyc-campaign.ts --execute  → réel (après OK)
 *         npx tsx scripts/kyc-campaign.ts --execute --limit 3 → 3 premiers seulement
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  sendKycIncompleteEmail, sendKycReceivedEmail, sendKycNoticeEmail,
} from '../src/services/email.js';

const EXECUTE = process.argv.includes('--execute');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
const casesIdx = process.argv.indexOf('--cases');
const CASES = casesIdx > -1 ? new Set(process.argv[casesIdx + 1].split(',')) : null;
const pickIdx = process.argv.indexOf('--pick');
const PICK = pickIdx > -1 ? new Set(process.argv[pickIdx + 1].split(',')) : null;
const BATCH = 10;
const NOTICE_DAYS = 7;
const CAMPAIGN = 'kyc-compliance-2026-11';

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

// Blocklist SMTP Brevo (hard bounces, plaintes, désinscrits transactionnels)
async function fetchBrevoBlocked(): Promise<Set<string>> {
  const blocked = new Set<string>();
  const key = process.env.BREVO_API_KEY;
  if (!key) return blocked;
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`https://api.brevo.com/v3/smtp/blockedContacts?limit=100&offset=${offset}`, {
      headers: { 'api-key': key },
    });
    if (!r.ok) throw new Error(`blockedContacts HTTP ${r.status}`);
    const j = await r.json() as { contacts?: { email?: string }[] };
    const contacts = j.contacts ?? [];
    for (const c of contacts) {
      const e = (c.email ?? '').trim().toLowerCase();
      if (e) blocked.add(e);
    }
    if (contacts.length < 100) break;
  }
  return blocked;
}

async function main() {
  // Marchands déjà traités par cette campagne → exclus (idempotent)
  const { data: doneEvents, error: evErr } = await sb.from('merchant_kyc_events')
    .select('merchant_id').eq('details->>campaign', CAMPAIGN);
  if (evErr) throw evErr;
  const done = new Set((doneEvents ?? []).map((e) => e.merchant_id as string));

  const blocked = await fetchBrevoBlocked();

  const { data: merchants, error } = await sb
    .from('merchants')
    .select('id, name, email, mode, kyc_status, rccm_file_url, idnat_file_url, rep_id_file_url')
    .eq('status', 'active')
    .is('deleted_at', null);
  if (error) throw error;

  const actions: Action[] = [];
  let excluded = 0, alreadyDone = 0, blacklisted = 0, approvedSkipped = 0;
  const blockedList: string[] = [];

  for (const m of merchants ?? []) {
    if (EXCLUDE.has(m.id as string)) { excluded++; continue; }
    if (done.has(m.id as string)) { alreadyDone++; continue; }
    const docs = [m.rccm_file_url, m.idnat_file_url, m.rep_id_file_url].filter(Boolean).length;
    // Skip = approved ET 3 pièces présentes. Un approved sans pièces
    // complètes retombe dans les cas a (inactif) ou c (actif).
    if (m.kyc_status === 'approved' && docs === 3) { approvedSkipped++; continue; }
    if (blocked.has((m.email as string).trim().toLowerCase())) {
      blacklisted++;
      blockedList.push(`${m.name} <${m.email}>`);
      continue;
    }

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
      // a ou b — inactifs
      const target = docs === 3 ? 'b' : 'a';
      actions.push({ id: m.id as string, name: m.name as string, email: m.email as string, mode: m.mode as string, target, flagged });
    }
  }

  const counts = { a: 0, b: 0, c: 0 };
  for (const a of actions) counts[a.target]++;
  let run = actions;
  if (CASES) run = run.filter((a) => CASES.has(a.target));
  if (PICK) run = run.filter((a) => PICK.has(a.id));
  if (Number.isFinite(LIMIT)) run = run.slice(0, LIMIT);

  console.log(`\n${EXECUTE ? 'EXECUTION' : 'DRY-RUN'} : ${actions.length} marchands à traiter`);
  console.log(`  exclusions : ${excluded} manuelles · ${approvedSkipped} approved+3docs · ${alreadyDone} déjà traités (${CAMPAIGN}) · ${blacklisted} blacklist Brevo (sur ${blocked.size} contacts bloqués)`);
  if (blockedList.length) for (const b of blockedList) console.log(`    blacklist: ${b}`);
  console.log(`  a-suspended_kyc: ${counts.a} · b-kyc_required: ${counts.b} · c-préavis J+7: ${counts.c} (deadline ${deadlineFr})`);
  for (const a of actions) if (a.target === 'c') console.log(`    c: ${a.name} <${a.email}> mode=${a.mode}`);
  if (PICK || CASES) for (const a of run) console.log(`    ${a.target}: ${a.id} ${a.name} <${a.email}>`);
  if (Number.isFinite(LIMIT)) console.log(`  --limit ${LIMIT} → ${run.length} marchand(s) concerné(s) sur ${actions.length}`);
  if (PICK && run.length !== PICK.size) console.warn(`  ⚠️ --pick : ${run.length}/${PICK.size} IDs résolus (les autres sont exclus/inconnus)`);

  if (!EXECUTE) { console.log('→ passez --execute pour appliquer (rien modifié)'); return; }

  let sent = 0, mailKo = 0, updateKo = 0;
  const sentCounts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < run.length; i += BATCH) {
    for (const a of run.slice(i, i + BATCH)) {
      // 1) mail d'abord — statut modifié seulement si messageId reçu
      let messageId: string | null = null;
      try {
        if (a.target === 'a') messageId = await sendKycIncompleteEmail(a.email, a.name);
        else if (a.target === 'b') messageId = await sendKycReceivedEmail(a.email, a.name);
        else messageId = await sendKycNoticeEmail(a.email, a.name, deadlineFr);
      } catch (e) {
        console.error(`  mail KO ${a.name} <${a.email}>:`, e);
        mailKo++;
        continue;
      }
      if (!messageId) {
        console.error(`  mail KO ${a.name} <${a.email}>: pas de messageId — statut inchangé`);
        mailKo++;
        continue;
      }

      // 2) update base + événement campagne
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
      if (upErr) { console.error(`  UPDATE KO ${a.id} ${a.name} (mail ${messageId} parti !):`, upErr.message); updateKo++; continue; }

      await sb.from('merchant_kyc_events').insert({
        merchant_id: a.id,
        event: a.target === 'c' ? 'notice_sent' : a.target === 'a' ? 'kyc_suspended' : 'kyc_required',
        actor: 'system',
        details: { campaign: CAMPAIGN, message_id: messageId, ...(a.target === 'c' ? { deadline: deadline.toISOString() } : {}) },
      });

      sent++;
      sentCounts[a.target]++;
      console.log(`  ${a.target} ✓ mail ${messageId} → ${a.name}`);
    }
    if (i + BATCH < run.length) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`=== campagne terminée : ${sent} envoyés (a:${sentCounts.a} b:${sentCounts.b} c:${sentCounts.c}) · ${mailKo} échecs mail · ${updateKo} échecs update ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
