/**
 * Relances KYC (cron x3, quotidien 08:00) — 3 flux :
 *
 *  1. Notice cas c : marchands sous préavis (kyc_deadline future) →
 *     relance à J+3 et J-1 avant l'échéance (event notice_reminder_j3 / jm1).
 *  2. Échéance dépassée (kyc_deadline < now) :
 *     - <3 pièces → suspended_kyc + mail « incomplet » + event deadline_passed
 *     - 3 pièces  → kyc_required (attente validation) + alerte admin + event
 *  3. Bloqués classiques : relances J+7 / J+21 (kyc_reminder_j7 / j21).
 *
 * Idempotent via merchant_kyc_events. Exclusions respectées :
 *   - EXCLUDE (liste manuelle ci-dessous),
 *   - marchands flaggés email_unreachable (hard bounce, blacklist…),
 *   - adresses présentes dans la blocklist SMTP Brevo — le changement de
 *     statut reste appliqué pour les échéances (flux 2), seul le mail est sauté.
 *
 * Usage : npx tsx scripts/kyc-reminders.ts [--dry-run] [--at YYYY-MM-DD]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  sendKycIncompleteEmail, sendKycReceivedEmail, sendKycNoticeEmail,
} from '../src/services/email.js';

const DRY_RUN = process.argv.includes('--dry-run');
const atIdx = process.argv.indexOf('--at');
const AT = atIdx > -1 ? process.argv[atIdx + 1] : null;
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const now = AT ? Date.parse(`${AT}T08:00:00Z`) : Date.now();
const nowIso = new Date(now).toISOString();

const EXCLUDE = new Set([
  '9c3e78bd-2292-47b2-8c01-3328cf55d84f', // Friktune (partenaire PRT-69D5A3E8, dossier hors système)
  '06ada919-15fd-4c34-9f88-3e7e22c4b3dd', // Congo Gaming (entité propriétaire)
  '8a377991-62b9-431d-af5c-f1b1fdc8dfd3', // IA-SOLUTION
  '00009263-dcc5-479d-8928-aa15d25a6f5c', // Ndako
]);

const hasEvent = async (mid: string, ev: string) => {
  const { data } = await sb.from('merchant_kyc_events').select('id')
    .eq('merchant_id', mid).eq('event', ev).limit(1);
  return (data ?? []).length > 0;
};

// Marchands flaggés email_unreachable (colonne merchants.email_unreachable ;
// les events 'email_unreachable' dans merchant_kyc_events restent la trace).
const unreachableSet = async () => {
  const { data } = await sb.from('merchants').select('id')
    .eq('email_unreachable', true).is('deleted_at', null);
  return new Set((data ?? []).map((e) => e.id as string));
};

// Blocklist SMTP Brevo (hard bounces, plaintes, désinscrits)
async function fetchBrevoBlocked(): Promise<Set<string>> {
  const blocked = new Set<string>();
  const key = process.env.BREVO_API_KEY;
  if (!key) return blocked;
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`https://api.brevo.com/v3/smtp/blockedContacts?limit=100&offset=${offset}`, {
      headers: { 'api-key': key },
    });
    if (!r.ok) { console.error(`blockedContacts HTTP ${r.status}`); break; }
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

const log = (m: string) => console.log(`${DRY_RUN ? '[dry] ' : ''}${m}`);

async function main() {
  const unreachable = await unreachableSet();
  const blocked = await fetchBrevoBlocked();
  // Peut-on envoyer un mail à ce marchand ?
  const canMail = (m: { id: unknown; email: unknown }) =>
    !unreachable.has(m.id as string) && !blocked.has((m.email as string).trim().toLowerCase());
  const skipReason = (m: { id: unknown; email: unknown }) =>
    unreachable.has(m.id as string) ? 'email_unreachable' : 'blacklist Brevo';

  if (AT) log(`simulation --at ${AT} (now=${nowIso})`);

  // ── 1+2. Marchands sous préavis / échéance dépassée ──────────
  for (const m of (await sb.from('merchants')
      .select('id, name, email, access_status, kyc_deadline, rccm_file_url, idnat_file_url, rep_id_file_url')
      .eq('status', 'active').not('kyc_deadline', 'is', null).is('deleted_at', null)).data ?? []) {
    if (EXCLUDE.has(m.id as string)) continue;
    const dl = new Date(m.kyc_deadline as string).getTime();
    // Comparaison au jour (UTC) : l'échéance n'est dépassée que lorsque la
    // date du jour est strictement postérieure à la date de kyc_deadline
    // (deadline 13 nov. → suspension au run du 14 nov., pas le 13).
    const todayUtc = new Date(now); todayUtc.setUTCHours(0, 0, 0, 0);
    const dlDayUtc = new Date(dl); dlDayUtc.setUTCHours(0, 0, 0, 0);
    const daysLeft = (dlDayUtc.getTime() - todayUtc.getTime()) / 86400e3;
    const dlFr = new Date(dl).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const docs = [m.rccm_file_url, m.idnat_file_url, m.rep_id_file_url].filter(Boolean).length;

    if (daysLeft > 0 && m.access_status === 'active') {
      // Relances J+3 (≈ J-4) et J-1
      const since = NOTICE_FROM(now, dl);
      if (since >= 3 * 86400e3 && !(await hasEvent(m.id as string, 'notice_reminder_j3'))) {
        if (!canMail(m)) { log(`notice J+3 SAUTÉ (${skipReason(m)}) → ${m.name}`); if (!DRY_RUN) await ev(m.id as string, 'notice_reminder_j3', { daysLeft, skipped: skipReason(m) }); }
        else { log(`notice J+3 → ${m.name}`); if (!DRY_RUN) { await sendKycNoticeEmail(m.email as string, m.name as string, dlFr); await ev(m.id as string, 'notice_reminder_j3', { daysLeft }); } }
      }
      if (daysLeft <= 1 && !(await hasEvent(m.id as string, 'notice_reminder_jm1'))) {
        if (!canMail(m)) { log(`notice J-1 SAUTÉ (${skipReason(m)}) → ${m.name}`); if (!DRY_RUN) await ev(m.id as string, 'notice_reminder_jm1', { daysLeft, skipped: skipReason(m) }); }
        else { log(`notice J-1 → ${m.name}`); if (!DRY_RUN) { await sendKycNoticeEmail(m.email as string, m.name as string, dlFr); await ev(m.id as string, 'notice_reminder_jm1', { daysLeft }); } }
      }
      continue;
    }

    if (daysLeft < 0 && m.access_status === 'active') {
      // Échéance dépassée — le statut bascule même si le mail est sauté (injoignable)
      const mailOk = canMail(m);
      if (docs < 3) {
        log(`deadline PASSÉ, incomplet → suspended_kyc ${m.name}${mailOk ? '' : ` (mail sauté : ${skipReason(m)})`}`);
        if (!DRY_RUN) {
          await sb.from('merchants').update({
            access_status: 'suspended_kyc', access_status_changed_at: nowIso,
            access_status_reason: 'Préavis expiré sans dossier complet', kyc_deadline: null,
          }).eq('id', m.id);
          await ev(m.id as string, 'deadline_passed', { outcome: 'suspended', ...(mailOk ? {} : { mail_skipped: skipReason(m) }) });
          if (mailOk) await sendKycIncompleteEmail(m.email as string, m.name as string);
        }
      } else {
        log(`deadline PASSÉ, 3 pièces → kyc_required (attente validation) ${m.name} — ALERTE ADMIN`);
        if (!DRY_RUN) {
          await sb.from('merchants').update({
            access_status: 'kyc_required', access_status_changed_at: nowIso,
            access_status_reason: 'Dossier reçu, en attente de validation admin', kyc_deadline: null,
          }).eq('id', m.id);
          await ev(m.id as string, 'deadline_passed', { outcome: 'pending_validation' });
          // alerte admin : dossier arrivé à l'échéance, à valider
          const { sendAdminDirectEmail } = await import('../src/services/email.js');
          const { env } = await import('../src/config/env.js');
          for (const adminMail of env.ADMIN_EMAILS.split(',')) {
            await sendAdminDirectEmail(
              adminMail.trim(),
              `KYC à valider : ${m.name}`,
              `Le marchand ${m.name} (${m.id as string}) a envoyé ses 3 documents à l'échéance de son préavis KYC. Son dossier est en attente de validation admin.`,
            ).catch(() => {});
          }
        }
      }
    }
  }

  // ── 3. Relances bloqués J+7 / J+21 ───────────────────────────
  for (const { days, event } of [{ days: 7, event: 'kyc_reminder_j7' }, { days: 21, event: 'kyc_reminder_j21' }]) {
    const cutoff = new Date(now - days * 86400e3).toISOString();
    const { data: merchants } = await sb.from('merchants')
      .select('id, name, email, access_status')
      .eq('status', 'active').neq('access_status', 'active').lte('access_status_changed_at', cutoff).is('deleted_at', null);
    for (const m of merchants ?? []) {
      if (EXCLUDE.has(m.id as string) || (await hasEvent(m.id as string, event))) continue;
      if (!canMail(m)) {
        log(`${event} SAUTÉ (${skipReason(m)}) → ${m.name} (${m.access_status})`);
        if (!DRY_RUN) await ev(m.id as string, event, { days, skipped: skipReason(m) });
        continue;
      }
      log(`${event} → ${m.name} (${m.access_status})`);
      if (!DRY_RUN) {
        if (m.access_status === 'suspended_kyc') await sendKycIncompleteEmail(m.email as string, m.name as string);
        else await sendKycReceivedEmail(m.email as string, m.name as string);
        await ev(m.id as string, event, { days });
      }
    }
  }
}

const NOTICE_FROM = (now: number, dl: number) => now - (dl - 7 * 86400e3);
const ev = (mid: string, event: string, details: Record<string, unknown>) =>
  sb.from('merchant_kyc_events').insert({ merchant_id: mid, event, actor: 'system', details }).then(() => {});

main().catch((e) => { console.error(e); process.exit(1); });
