/**
 * Unipesa reconciliation worker for UniPay API.
 *
 * Background safety net that resolves transactions left in 'processing'
 * by the payment initiate route when the provider call timed out or the
 * provider returned a non-terminal status. Mirrors the Congo Gaming
 * reconciliation worker (congogaming-platform/server/lib/unipesa-
 * reconciliation.ts) but adapted to the UniPay schema:
 *
 *   - UniPay transactions.status is TEXT ('processing'), not INTEGER (1).
 *   - UniPay uses process_wallet_provider_callback() for atomic
 *     credit/refund, so this worker reuses that RPC instead of
 *     duplicating the balance logic. The callback RPC handles both
 *     wallet-user and merchant-ledger paths.
 *   - UniPay uses getTransactionStatus() from services/avada.ts which
 *     already exempts /status from the result.code check (commit c7c8534).
 *
 * Concurrency hardening:
 *   1. Worker-level lock (worker_locks table, TTL 2 min) so only one
 *      reconciliation tick runs at a time across the whole fleet.
 *   2. Row-level claim via claim_pending_unipay_transactions RPC,
 *      which uses SELECT ... FOR UPDATE SKIP LOCKED + a stamp on
 *      reconcile_attempted_at.
 *   3. Idempotency: process_wallet_provider_callback inserts into
 *      provider_webhook_events with a UNIQUE(provider, provider_event_id)
 *      constraint, so a callback and a reconciliation tick racing on the
 *      same transaction cannot produce a double credit/refund.
 *
 * Inbound callbacks remain authoritative — this worker only resolves
 * orders that callbacks failed to deliver.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTransactionStatusWithRaw } from './avada';
export declare const RECONCILE_NOT_FOUND_GRACE_SECONDS: number;
export type PendingSettlement = {
    id: string;
    merchant_id: string;
    amount: number;
    currency: string;
    phone: string;
    provider_ref: string | null;
    created_at: string;
};
interface ReconciliationLogger {
    info: (data: unknown, message?: string) => void;
    warn: (data: unknown, message?: string) => void;
    error: (data: unknown, message?: string) => void;
}
export declare function reconcileOneSettlement(supabase: SupabaseClient, settlement: PendingSettlement, log: ReconciliationLogger, getStatus?: typeof getTransactionStatusWithRaw): Promise<void>;
export declare function runReconciliationTick(supabase: SupabaseClient, log: ReconciliationLogger): Promise<void>;
/**
 * Start the reconciliation loop. Follows the same pattern as
 * startOnchainReconciler (services/onchain-reconciliation.ts):
 *   - guards against overlapping ticks with a `running` flag
 *   - fires an initial tick after a 30s stagger (so we don't pile
 *     work on top of boot-time recovery jobs)
 *   - setInterval with .unref() so the timer doesn't keep the
 *     process alive on shutdown
 */
export declare function startUnipesaReconciler(supabase: SupabaseClient, log: ReconciliationLogger, intervalMs?: number): void;
export {};
