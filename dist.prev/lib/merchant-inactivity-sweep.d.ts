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
/**
 * Run the daily inactivity sweep.
 *
 * @param supabase - Fastify supabase instance (service role, bypasses RLS)
 * @returns Summary of actions taken
 */
export declare function runMerchantInactivitySweep(supabase: FastifyInstance['supabase']): Promise<SweepResult>;
export {};
