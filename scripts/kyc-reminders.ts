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
 * Idempotent via merchant_kyc_events. Exclusions respectées.
 * Usage : npx tsx scripts/kyc-reminders.ts [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import {
  sendKycIncompleteEmail, sendKycReceivedEmail, sendKycNoticeEmail,
} from '../src/services/email.js';

const DRY_RUN = process.argv.includes('--dry-run');
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const now = Date.now();
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

const log = (m: string) => console.log(`${DRY_RUN ? '[dry] ' : ''}${m}`);

async function main() {
  // ── 1+2. Marchands sous préavis / échéance dépassée ──────────
  for (const m of (await sb.from('merchants')
      .select('id, name, email, access_status, kyc_deadline, rccm_file_url, idnat_file_url, rep_id_file_url')
      .not('kyc_deadline', 'is', null).is('deleted_at', null)).data ?? []) {
    if (EXCLUDE.has(m.id as string)) continue;
    const dl = new Date(m.kyc_deadline as string).getTime();
    const daysLeft = (dl - now) / 86400e3;
    const dlFr = new Date(dl).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const docs = [m.rccm_file_url, m.idnat_file_url, m.rep_id_file_url].filter(Boolean).length;

    if (daysLeft > 0 && m.access_status === 'active') {
      // Relances J+3 (≈ J-4) et J-1
      const since = NOTICE_FROM(now, dl);
      if (since >= 3 * 86400e3 && !(await hasEvent(m.id as string, 'notice_reminder_j3'))) {
        log(`notice J+3 → ${m.name}`); if (!DRY_RUN) { await sendKycNoticeEmail(m.email as string, m.name as string, dlFr); await ev(m.id as string, 'notice_reminder_j3', { daysLeft }); }
      }
      if (daysLeft <= 1 && !(await hasEvent(m.id as string, 'notice_reminder_jm1'))) {
        log(`notice J-1 → ${m.name}`); if (!DRY_RUN) { await sendKycNoticeEmail(m.email as string, m.name as string, dlFr); await ev(m.id as string, 'notice_reminder_jm1', { daysLeft }); }
      }
      continue;
    }

    if (daysLeft <= 0 && m.access_status === 'active') {
      // Échéance dépassée
      if (docs < 3) {
        log(`deadline PASSÉ, incomplet → suspended_kyc ${m.name}`);
        if (!DRY_RUN) {
          await sb.from('merchants').update({
            access_status: 'suspended_kyc', access_status_changed_at: nowIso,
            access_status_reason: 'Préavis expiré sans dossier complet', kyc_deadline: null,
          }).eq('id', m.id);
          await ev(m.id as string, 'deadline_passed', { outcome: 'suspended' });
          await sendKycIncompleteEmail(m.email as string, m.name as string);
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
      .neq('access_status', 'active').lte('access_status_changed_at', cutoff).is('deleted_at', null);
    for (const m of merchants ?? []) {
      if (EXCLUDE.has(m.id as string) || (await hasEvent(m.id as string, event))) continue;
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
