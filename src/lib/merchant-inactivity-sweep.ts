/**
 * merchant-inactivity-sweep.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily cron job: automatic merchant sorting by activity level.
 *
 * Eligibility: kyc_status='pending' AND volume=0 (no successful transactions).
 * Accounts with approved KYC or any transaction volume are never concerned.
 *
 * Lifecycle (days since registration):
 *   J0-J3   : active (normal, no action)
 *   J3      : reminder email #1 ("Rappel inscription J3") — step 1
 *   J7      : → inactivity_status='to_relaunch' + email #2 ("Relance inscription J7") — step 2
 *   J12     : email #3 ("Avertissement archivage J12") — step 3
 *   J14     : → inactivity_status='inactive' (hidden from default dashboard view)
 *   J104    : soft-delete (deleted_at = now())
 *
 * Exit condition: if at any point the merchant submits KYC (kyc_status changes
 * from 'pending') or makes a transaction, they exit the lifecycle and return to
 * inactivity_status='active', last_reminder_step=0.
 *
 * Audit: all actions logged to merchant_inactivity_log.
 *
 * @copyright (c) 2026 UniPay Congo / Congo Gaming Limited S.a.r.l
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { FastifyInstance } from 'fastify';
import { sendTemplateAuto } from './email-auto-send.js';
import type { MerchantTemplateData } from './email-templates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Lifecycle thresholds (in days since registration)
const REMINDER_J3 = 3;
const RELANCE_J7 = 7;
const WARNING_J12 = 12;
const INACTIVE_J14 = 14;
const SOFT_DELETE_J104 = 104;

interface MerchantRow {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  country: string;
  mode: string;
  kyc_status: string;
  status: string;
  company_name: string | null;
  company_rccm: string | null;
  company_idnat: string | null;
  kyc_notes: string | null;
  kyc_submitted_at: string | null;
  kyc_reviewed_at: string | null;
  created_at: string;
  inactivity_status: string;
  inactivity_status_changed_at: string | null;
  last_reminder_sent_at: string | null;
  last_reminder_step: number;
  deleted_at: string | null;
}

interface SweepResult {
  scanned: number;
  eligible: number;
  reminders_sent: number;
  status_changes: number;
  soft_deletes: number;
  reactivations: number;
  errors: number;
  details: Array<{
    merchant_id: string;
    email: string;
    action: string;
    reason?: string;
  }>;
}

async function logAction(
  supabase: FastifyInstance['supabase'],
  merchantId: string,
  action: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase
    .from('merchant_inactivity_log')
    .insert({ merchant_id: merchantId, action, reason: reason ?? null });
  if (error) {
    console.error(`[inactivity-sweep] failed to log action ${action} for ${merchantId}:`, error.message);
  }
}

async function sendReminderEmail(
  merchant: MerchantRow,
  templateLabel: string,
): Promise<boolean> {
  const templateData: MerchantTemplateData = {
    name: merchant.name ?? merchant.email,
    email: merchant.email,
    phone: merchant.phone,
    kyc_status: merchant.kyc_status,
    mode: merchant.mode,
    status: merchant.status,
    company_name: merchant.company_name,
    company_rccm: merchant.company_rccm,
    company_idnat: merchant.company_idnat,
    kyc_notes: merchant.kyc_notes,
    kyc_submitted_at: merchant.kyc_submitted_at,
    kyc_reviewed_at: merchant.kyc_reviewed_at,
  };

  const result = await sendTemplateAuto('merchant', templateData, merchant.email, templateLabel);
  if (!result.sent) {
    console.warn(`[inactivity-sweep] email ${templateLabel} failed for ${merchant.email}: ${result.error}`);
  }
  return result.sent;
}

/**
 * Run the daily inactivity sweep.
 *
 * @param supabase - Fastify supabase instance (service role, bypasses RLS)
 * @returns Summary of actions taken
 */
export async function runMerchantInactivitySweep(
  supabase: FastifyInstance['supabase'],
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    eligible: 0,
    reminders_sent: 0,
    status_changes: 0,
    soft_deletes: 0,
    reactivations: 0,
    errors: 0,
    details: [],
  };

  const now = Date.now();

  // ── Step 1: Fetch all non-deleted merchants ─────────────────
  const { data: allMerchants, error: fetchErr } = await supabase
    .from('merchants')
    .select(
      'id, name, email, phone, country, mode, kyc_status, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at, created_at, inactivity_status, inactivity_status_changed_at, last_reminder_sent_at, last_reminder_step, deleted_at',
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (fetchErr) {
    console.error('[inactivity-sweep] failed to fetch merchants:', fetchErr.message);
    result.errors++;
    return result;
  }

  result.scanned = (allMerchants ?? []).length;

  // ── Step 2: Fetch set of merchant_ids with at least one successful tx ──
  // This is the same logic as the admin list endpoint (transactions with
  // status='success'). A single query returns distinct merchant_ids.
  const { data: txMerchants, error: txErr } = await supabase
    .from('transactions')
    .select('merchant_id')
    .not('merchant_id', 'is', null)
    .eq('status', 'success');

  if (txErr) {
    console.error('[inactivity-sweep] failed to fetch transaction merchant_ids:', txErr.message);
    result.errors++;
    return result;
  }

  const merchantsWithVolume = new Set<string>();
  for (const t of txMerchants ?? []) {
    const mid = (t as { merchant_id: string }).merchant_id;
    if (mid) merchantsWithVolume.add(mid);
  }

  // ── Step 3: Process each merchant ──────────────────────────
  for (const row of allMerchants ?? []) {
    const m = row as MerchantRow;
    const ageDays = Math.floor((now - new Date(m.created_at).getTime()) / DAY_MS);

    // ── Exit/reactivation check ──
    // If the merchant has volume OR has submitted/approved KYC, they should
    // be 'active' regardless of their current inactivity_status.
    const hasVolume = merchantsWithVolume.has(m.id);
    const hasKycProgress = m.kyc_status !== 'pending';

    if (hasVolume || hasKycProgress) {
      // Merchant is active — reset inactivity if they were in the lifecycle
      if (m.inactivity_status !== 'active' || m.last_reminder_step > 0) {
        const { error } = await supabase
          .from('merchants')
          .update({
            inactivity_status: 'active',
            inactivity_status_changed_at: new Date().toISOString(),
            last_reminder_step: 0,
            last_reminder_sent_at: null,
          })
          .eq('id', m.id);

        if (error) {
          console.error(`[inactivity-sweep] reactivation update failed for ${m.id}:`, error.message);
          result.errors++;
        } else {
          result.reactivations++;
          await logAction(supabase, m.id, 'reactivated',
            hasVolume ? 'Transaction detected — exited inactivity lifecycle'
                      : `KYC status changed to '${m.kyc_status}' — exited inactivity lifecycle`);
          result.details.push({ merchant_id: m.id, email: m.email, action: 'reactivated' });
        }
      }
      continue; // Not eligible for inactivity processing
    }

    // ── Eligibility check ──
    // Only kyc_status='pending' AND volume=0 AND status='active' (not suspended)
    if (m.kyc_status !== 'pending' || hasVolume || m.status === 'suspended') {
      continue; // Not eligible
    }

    result.eligible++;

    // ── Lifecycle processing ──
    // J104: soft-delete (90 days after inactive)
    if (ageDays >= SOFT_DELETE_J104 && m.inactivity_status === 'inactive') {
      const { error } = await supabase
        .from('merchants')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', m.id);

      if (error) {
        console.error(`[inactivity-sweep] soft-delete failed for ${m.id}:`, error.message);
        result.errors++;
      } else {
        result.soft_deletes++;
        await logAction(supabase, m.id, 'soft_deleted',
          `Inactive for ${ageDays} days (>= ${SOFT_DELETE_J104}) — soft-deleted`);
        result.details.push({ merchant_id: m.id, email: m.email, action: 'soft_deleted' });
      }
      continue;
    }

    // J14: mark as inactive
    if (ageDays >= INACTIVE_J14 && m.inactivity_status !== 'inactive') {
      const { error } = await supabase
        .from('merchants')
        .update({
          inactivity_status: 'inactive',
          inactivity_status_changed_at: new Date().toISOString(),
        })
        .eq('id', m.id);

      if (error) {
        console.error(`[inactivity-sweep] mark inactive failed for ${m.id}:`, error.message);
        result.errors++;
      } else {
        result.status_changes++;
        await logAction(supabase, m.id, 'marked_inactive',
          `No activity for ${ageDays} days (>= ${INACTIVE_J14}) — marked inactive`);
        result.details.push({ merchant_id: m.id, email: m.email, action: 'marked_inactive' });
      }
      continue;
    }

    // J12: warning email (2 days before inactive at J14)
    if (ageDays >= WARNING_J12 && m.last_reminder_step < 3) {
      const sent = await sendReminderEmail(m, 'Avertissement archivage J12');
      if (sent) {
        result.reminders_sent++;
        const { error } = await supabase
          .from('merchants')
          .update({
            last_reminder_step: 3,
            last_reminder_sent_at: new Date().toISOString(),
          })
          .eq('id', m.id);

        if (error) console.error(`[inactivity-sweep] update step=3 failed for ${m.id}:`, error.message);
        await logAction(supabase, m.id, 'reminder_j12', 'Warning email sent (J12 — 2 days before inactive)');
        result.details.push({ merchant_id: m.id, email: m.email, action: 'reminder_j12' });
      } else {
        result.errors++;
      }
      continue;
    }

    // J7: mark as to_relaunch + relance email
    if (ageDays >= RELANCE_J7 && m.inactivity_status === 'active') {
      // First: send the J7 relance email (step 2)
      const sent = await sendReminderEmail(m, 'Relance inscription J7');
      if (sent) {
        result.reminders_sent++;
      } else {
        result.errors++;
      }

      // Then: update status to to_relaunch
      const { error } = await supabase
        .from('merchants')
        .update({
          inactivity_status: 'to_relaunch',
          inactivity_status_changed_at: new Date().toISOString(),
          last_reminder_step: 2,
          last_reminder_sent_at: new Date().toISOString(),
        })
        .eq('id', m.id);

      if (error) {
        console.error(`[inactivity-sweep] mark to_relaunch failed for ${m.id}:`, error.message);
        result.errors++;
      } else {
        result.status_changes++;
        await logAction(supabase, m.id, 'marked_to_relaunch',
          `No activity for ${ageDays} days (>= ${RELANCE_J7}) — marked to_relaunch`);
        await logAction(supabase, m.id, 'reminder_j7', 'Relance email sent (J7)');
        result.details.push({ merchant_id: m.id, email: m.email, action: 'marked_to_relaunch' });
      }
      continue;
    }

    // J3: first soft reminder (only if not already sent)
    if (ageDays >= REMINDER_J3 && m.last_reminder_step < 1) {
      const sent = await sendReminderEmail(m, 'Rappel inscription J3');
      if (sent) {
        result.reminders_sent++;
        const { error } = await supabase
          .from('merchants')
          .update({
            last_reminder_step: 1,
            last_reminder_sent_at: new Date().toISOString(),
          })
          .eq('id', m.id);

        if (error) console.error(`[inactivity-sweep] update step=1 failed for ${m.id}:`, error.message);
        await logAction(supabase, m.id, 'reminder_j3', 'Soft reminder email sent (J3)');
        result.details.push({ merchant_id: m.id, email: m.email, action: 'reminder_j3' });
      } else {
        result.errors++;
      }
      continue;
    }
  }

  return result;
}
