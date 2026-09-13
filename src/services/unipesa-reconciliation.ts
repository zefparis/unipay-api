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
import { getTransactionStatusWithRaw, type AvadaStatus } from './avada';
import { notifyMerchantWebhook } from '../lib/merchant-webhook';

const WORKER_NAME = 'unipay_unipesa_reconciliation';
const LOCK_TTL_SECONDS = 120;

const BATCH_SIZE = 50;
// Do not touch transactions younger than this — the request handler
// might still be writing the final status, and the inbound callback
// might still be in flight.
const MIN_AGE_SECONDS = 90;
// Cooldown before a row that we already attempted can be retried
// (covers crashes after RPC claim but before status resolution).
const RETRY_AFTER_SECONDS = 90;
// Stop reconciling rows older than this — they are likely lost
// causes and we do not want to keep paging Unipesa for them forever.
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type PendingTx = {
  id: string;
  reference: string | null;
  merchant_id: string | null;
  wallet_user_id: string | null;
  operator: string;
  direction: string;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  status: string;
  avada_transaction_id: string | null;
  created_at: string;
};

type PendingSettlement = {
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

/**
 * Map Unipesa numeric status (0-3) to UniPay text status.
 * 0=pending, 1=processing, 2=success, 3=failed.
 */
function mapUnipesaStatus(remoteStatus: number): 'success' | 'failed' | null {
  if (remoteStatus === 2) return 'success';
  if (remoteStatus === 3) return 'failed';
  return null; // 0 (pending) or 1 (processing) — not terminal
}

async function tryAcquireLock(supabase: SupabaseClient, log: ReconciliationLogger): Promise<boolean> {
  const { data, error } = await supabase.rpc('try_acquire_worker_lock', {
    p_worker_name: WORKER_NAME,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (error) {
    log.error({ event: 'reconciliation_lock_error', err: error.message }, 'lock RPC failed');
    return false;
  }
  return data === true;
}

async function releaseLock(supabase: SupabaseClient, log: ReconciliationLogger): Promise<void> {
  const { error } = await supabase.rpc('release_worker_lock', {
    p_worker_name: WORKER_NAME,
  });
  if (error) {
    log.warn({ event: 'reconciliation_unlock_error', err: error.message }, 'unlock RPC failed');
  }
}

async function logTooOldPending(supabase: SupabaseClient, log: ReconciliationLogger): Promise<void> {
  const cutoff = new Date(Date.now() - MAX_AGE_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from('transactions')
    .select('id, reference, direction, amount, created_at')
    .eq('status', 'processing')
    .lt('created_at', cutoff)
    .limit(20);
  if (error) {
    log.warn({ event: 'reconciliation_age_probe_failed', err: error.message });
    return;
  }
  if (!data || data.length === 0) return;
  for (const row of data) {
    log.warn(
      {
        event: 'transaction_too_old_for_reconcile',
        reference: (row as Record<string, unknown>).reference,
        transactionId: (row as Record<string, unknown>).id,
        direction: (row as Record<string, unknown>).direction,
        amount: (row as Record<string, unknown>).amount,
        createdAt: (row as Record<string, unknown>).created_at,
      },
      'pending transaction past max age — manual investigation required',
    );
  }
}

async function reconcileOneSettlement(
  supabase: SupabaseClient,
  settlement: PendingSettlement,
  log: ReconciliationLogger,
): Promise<void> {
  const start = Date.now();
  // Use provider_ref (avada_transaction_id) to query Unipesa /status.
  // If provider_ref is null, we cannot reconcile — skip.
  const statusKey = settlement.provider_ref;
  if (!statusKey) {
    log.warn(
      {
        event: 'settlement_reconciliation_skipped',
        settlementId: settlement.id,
        reason: 'missing_provider_ref',
      },
      'settlement has no provider_ref — cannot query Unipesa',
    );
    return;
  }

  let remoteStatusRaw: AvadaStatus;
  let rawResponse: Record<string, unknown> = {};
  try {
    const statusResult = await getTransactionStatusWithRaw(statusKey);
    remoteStatusRaw = statusResult.status;
    rawResponse = statusResult.raw;
  } catch (err) {
    log.warn(
      {
        event: 'settlement_reconciliation_failed',
        settlementId: settlement.id,
        providerRef: statusKey,
        amount: settlement.amount,
        latencyMs: Date.now() - start,
        errorCode: (err as Error)?.message,
      },
      'settlement reconciliation status check failed (will retry next tick)',
    );
    return;
  }

  const latencyMs = Date.now() - start;

  if (remoteStatusRaw === 'pending' || remoteStatusRaw === 'processing') {
    log.info(
      {
        event: 'settlement_still_pending',
        settlementId: settlement.id,
        providerRef: statusKey,
        amount: settlement.amount,
        providerStatus: remoteStatusRaw,
        latencyMs,
      },
      'settlement still pending upstream',
    );
    return;
  }

  const dbStatus = remoteStatusRaw === 'success' ? 'success'
    : remoteStatusRaw === 'failed' || remoteStatusRaw === 'cancelled' ? 'failed'
    : null;

  if (!dbStatus) {
    log.warn(
      {
        event: 'settlement_reconciliation_unknown_status',
        settlementId: settlement.id,
        providerRef: statusKey,
        providerStatus: remoteStatusRaw,
        latencyMs,
      },
      'unknown provider status — skipping settlement',
    );
    return;
  }

  // Look up the linked transactions row (if any) so we can reuse the
  // atomic process_wallet_provider_callback RPC, which propagates the
  // terminal status to the settlement request via settlement_request_id.
  // This avoids duplicating the refund logic and keeps idempotency.
  const { data: linkedTx, error: txLookupErr } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('settlement_request_id', settlement.id)
    .maybeSingle();

  if (txLookupErr) {
    log.warn(
      {
        event: 'settlement_reconciliation_failed',
        settlementId: settlement.id,
        err: txLookupErr.message,
      },
      'linked transaction lookup failed',
    );
    return;
  }

  if (!linkedTx) {
    // No linked transactions row — this settlement predates the fix
    // (or was created by a path that did not insert a transactions row).
    // Fall back to calling the settlement RPCs directly.
    log.warn(
      {
        event: 'settlement_reconciliation_no_linked_tx',
        settlementId: settlement.id,
        providerRef: statusKey,
      },
      'settlement has no linked transactions row — direct settlement RPC fallback',
    );

    const providerEventId = `reconcile_settlement_direct:${settlement.id}:${dbStatus}`;
    const reconciledPayload: Record<string, unknown> = {
      reconciled: true,
      reconciled_by: WORKER_NAME,
      reconciled_at: new Date().toISOString(),
      provider_status: remoteStatusRaw,
    };
    if (rawResponse['result'] && typeof rawResponse['result'] === 'object') {
      reconciledPayload['result'] = rawResponse['result'];
    }
    if (rawResponse['provider_result'] && typeof rawResponse['provider_result'] === 'object') {
      reconciledPayload['provider_result'] = rawResponse['provider_result'];
    }

    if (dbStatus === 'success') {
      const { error } = await supabase.rpc('mark_settlement_success', {
        p_request_id: settlement.id,
        p_provider_ref: statusKey,
      });
      if (error) {
        log.warn(
          { event: 'settlement_reconciliation_failed', settlementId: settlement.id, err: error.message },
          'mark_settlement_success failed (may already be terminal)',
        );
      } else {
        log.info(
          { event: 'settlement_reconciled', settlementId: settlement.id, providerStatus: remoteStatusRaw, latencyMs },
          'reconciled settlement (direct success)',
        );
      }
    } else {
      const { error } = await supabase.rpc('mark_settlement_failed', {
        p_request_id: settlement.id,
        p_reason: `Reconciliation: provider status ${remoteStatusRaw}`,
      });
      if (error) {
        log.warn(
          { event: 'settlement_reconciliation_failed', settlementId: settlement.id, err: error.message },
          'mark_settlement_failed failed (may already be terminal)',
        );
      } else {
        log.info(
          { event: 'settlement_reconciled', settlementId: settlement.id, providerStatus: remoteStatusRaw, latencyMs },
          'reconciled settlement (direct failed + refund)',
        );
      }
    }
    return;
  }

  // Linked transactions row exists — reuse the atomic callback RPC,
  // which will propagate the terminal status to the settlement request.
  const providerEventId = `reconcile_settlement:${settlement.id}:${dbStatus}`;
  const reconciledPayload: Record<string, unknown> = {
    reconciled: true,
    reconciled_by: WORKER_NAME,
    reconciled_at: new Date().toISOString(),
    provider_status: remoteStatusRaw,
    settlement_request_id: settlement.id,
  };
  if (rawResponse['result'] && typeof rawResponse['result'] === 'object') {
    reconciledPayload['result'] = rawResponse['result'];
  }
  if (rawResponse['provider_result'] && typeof rawResponse['provider_result'] === 'object') {
    reconciledPayload['provider_result'] = rawResponse['provider_result'];
  }

  const { data: callbackResult, error: callbackError } = await supabase.rpc(
    'process_wallet_provider_callback',
    {
      p_provider: 'unipesa',
      p_provider_event_id: providerEventId,
      p_transaction_id: (linkedTx as { id: string }).id,
      p_new_status: dbStatus,
      p_provider_transaction_id: statusKey,
      p_payload: reconciledPayload,
    },
  );

  if (callbackError) {
    log.error(
      {
        event: 'settlement_reconciliation_failed',
        settlementId: settlement.id,
        txId: (linkedTx as { id: string }).id,
        providerStatus: remoteStatusRaw,
        latencyMs,
        errorCode: callbackError.message,
      },
      'process_wallet_provider_callback failed for settlement',
    );
    return;
  }

  const result = callbackResult as { processed?: boolean; duplicate?: boolean; already_terminal?: boolean; settlement_updated?: boolean } | null;

  log.info(
    {
      event: 'settlement_reconciled',
      settlementId: settlement.id,
      txId: (linkedTx as { id: string }).id,
      amount: settlement.amount,
      providerStatus: remoteStatusRaw,
      processed: result?.processed ?? false,
      duplicate: result?.duplicate ?? false,
      alreadyTerminal: result?.already_terminal ?? false,
      settlementUpdated: result?.settlement_updated ?? false,
      latencyMs,
    },
    'reconciled settlement via linked transaction',
  );
}

async function reconcileOne(
  supabase: SupabaseClient,
  tx: PendingTx,
  log: ReconciliationLogger,
): Promise<void> {
  const start = Date.now();
  // Use the reference (our order_id) to query Unipesa /status. Fall back
  // to avada_transaction_id if reference is missing (shouldn't happen,
  // but be defensive — the callback stores avada_transaction_id).
  const statusKey = tx.reference ?? tx.avada_transaction_id ?? tx.id;
  let remoteStatusRaw: AvadaStatus;
  let rawResponse: Record<string, unknown> = {};
  try {
    const statusResult = await getTransactionStatusWithRaw(statusKey);
    remoteStatusRaw = statusResult.status;
    rawResponse = statusResult.raw;
  } catch (err) {
    log.warn(
      {
        event: 'transaction_reconciliation_failed',
        reference: tx.reference,
        transactionId: tx.id,
        direction: tx.direction,
        amount: tx.amount,
        latencyMs: Date.now() - start,
        errorCode: (err as Error)?.message,
      },
      'reconciliation status check failed (will retry next tick)',
    );
    return;
  }

  const latencyMs = Date.now() - start;

  // getTransactionStatus returns a text status ('pending','processing',
  // 'success','failed','cancelled'). Only 'success' and 'failed' are
  // terminal — anything else means Unipesa still considers the
  // transaction in flight.
  if (remoteStatusRaw === 'pending' || remoteStatusRaw === 'processing') {
    log.info(
      {
        event: 'transaction_still_pending',
        reference: tx.reference,
        transactionId: tx.id,
        direction: tx.direction,
        amount: tx.amount,
        providerStatus: remoteStatusRaw,
        latencyMs,
      },
      'still pending upstream',
    );
    return;
  }

  // Map to the UniPay DB status text expected by process_wallet_provider_callback.
  const dbStatus = remoteStatusRaw === 'success' ? 'success'
    : remoteStatusRaw === 'failed' || remoteStatusRaw === 'cancelled' ? 'failed'
    : null;

  if (!dbStatus) {
    log.warn(
      {
        event: 'transaction_reconciliation_unknown_status',
        reference: tx.reference,
        transactionId: tx.id,
        providerStatus: remoteStatusRaw,
        latencyMs,
      },
      'unknown provider status — skipping',
    );
    return;
  }

  // Use process_wallet_provider_callback for atomic resolution. This
  // RPC inserts into provider_webhook_events (idempotent via UNIQUE
  // constraint on provider+provider_event_id), updates the transaction
  // status, and applies the balance change (credit on collect success,
  // refund on payout failure). A concurrent inbound callback would
  // fail the UNIQUE insert and get 'duplicate' — no double application.
  const providerEventId = `reconcile:${tx.id}:${dbStatus}`;

  // Build enriched metadata: keep the reconciliation provenance fields
  // AND capture the raw Unipesa diagnostic data (result.code,
  // provider_result, transaction_id) so failed transactions can be
  // diagnosed without re-querying Unipesa.
  const reconciledPayload: Record<string, unknown> = {
    reconciled: true,
    reconciled_by: WORKER_NAME,
    reconciled_at: new Date().toISOString(),
    provider_status: remoteStatusRaw,
  };
  // Capture diagnostic fields from the raw Unipesa /status response.
  // These are the same fields seen in real callbacks (e.g.
  // provider_result.code, provider_result.message, result.code).
  if (rawResponse['result'] && typeof rawResponse['result'] === 'object') {
    reconciledPayload['result'] = rawResponse['result'];
  }
  if (rawResponse['provider_result'] && typeof rawResponse['provider_result'] === 'object') {
    reconciledPayload['provider_result'] = rawResponse['provider_result'];
  }
  if (rawResponse['transaction_id']) {
    reconciledPayload['unipesa_transaction_id'] = rawResponse['transaction_id'];
  }

  const { data: callbackResult, error: callbackError } = await supabase.rpc(
    'process_wallet_provider_callback',
    {
      p_provider: 'unipesa',
      p_provider_event_id: providerEventId,
      p_transaction_id: tx.id,
      p_new_status: dbStatus,
      p_provider_transaction_id: tx.avada_transaction_id ?? tx.reference ?? tx.id,
      p_payload: reconciledPayload,
    },
  );

  if (callbackError) {
    log.error(
      {
        event: 'transaction_reconciliation_failed',
        reference: tx.reference,
        transactionId: tx.id,
        direction: tx.direction,
        providerStatus: remoteStatusRaw,
        latencyMs,
        errorCode: callbackError.message,
      },
      'process_wallet_provider_callback failed',
    );
    return;
  }

  const result = callbackResult as { processed?: boolean; duplicate?: boolean; already_terminal?: boolean; credited?: number; refunded?: number } | null;

  if (!result?.processed) {
    log.info(
      {
        event: 'transaction_reconciled',
        reference: tx.reference,
        transactionId: tx.id,
        direction: tx.direction,
        providerStatus: remoteStatusRaw,
        duplicate: result?.duplicate ?? false,
        alreadyTerminal: result?.already_terminal ?? false,
        latencyMs,
      },
      'reconciliation skipped (duplicate or already terminal)',
    );
    return;
  }

  log.info(
    {
      event: 'transaction_reconciled',
      reference: tx.reference,
      transactionId: tx.id,
      direction: tx.direction,
      amount: tx.amount,
      providerStatus: remoteStatusRaw,
      credited: result.credited ?? 0,
      refunded: result.refunded ?? 0,
      latencyMs,
    },
    'reconciled transaction',
  );

  // Notify merchant webhook — fire and forget, HMAC-signed. Uses the
  // same shared helper as payment/callback.ts so the payload shape and
  // signing are identical regardless of the resolution path. This
  // ensures merchants are notified of failures detected by
  // reconciliation (no inbound callback) — previously they had to
  // poll the API to discover these.
  if (tx.merchant_id) {
    void notifyMerchantWebhook(supabase, {
      id: tx.id,
      merchant_id: tx.merchant_id,
      reference: tx.reference,
      avada_transaction_id: tx.avada_transaction_id,
    }, dbStatus, log);
  }
}

export async function runReconciliationTick(
  supabase: SupabaseClient,
  log: ReconciliationLogger,
): Promise<void> {
  const tickStart = Date.now();

  const acquired = await tryAcquireLock(supabase, log);
  if (!acquired) {
    log.info(
      { event: 'reconciliation_skipped_lock_held', worker: WORKER_NAME },
      'reconciliation skipped: lock already held',
    );
    return;
  }

  log.info({ event: 'reconciliation_started', worker: WORKER_NAME }, 'reconciliation tick started');

  try {
    // Surface stale-pending transactions so admins see them in logs;
    // the claim RPC will not pull them in (older than max_age).
    await logTooOldPending(supabase, log);

    const { data: rows, error } = await supabase.rpc(
      'claim_pending_unipay_transactions',
      {
        p_min_age_seconds: MIN_AGE_SECONDS,
        p_max_age_seconds: MAX_AGE_SECONDS,
        p_batch_size: BATCH_SIZE,
        p_retry_after_seconds: RETRY_AFTER_SECONDS,
      },
    );

    if (error) {
      log.error(
        { event: 'reconciliation_claim_failed', err: error.message },
        'claim RPC failed',
      );
      return;
    }

    const claimed = (rows as PendingTx[] | null) ?? [];
    if (claimed.length === 0) {
      log.info(
        { event: 'reconciliation_completed', claimed: 0, latencyMs: Date.now() - tickStart },
        'reconciliation tick complete (no work)',
      );
      return;
    }

    let succeeded = 0;
    let failed = 0;
    for (const tx of claimed) {
      try {
        await reconcileOne(supabase, tx, log);
        succeeded += 1;
      } catch (err) {
        failed += 1;
        log.error(
          {
            event: 'transaction_reconciliation_failed',
            reference: tx.reference,
            transactionId: tx.id,
            errorCode: (err as Error)?.message,
          },
          'reconcile_one threw',
        );
      }
    }

    log.info(
      {
        event: 'reconciliation_completed',
        claimed: claimed.length,
        succeeded,
        failed,
        latencyMs: Date.now() - tickStart,
      },
      'reconciliation tick complete (transactions)',
    );

    // ── Settlement reconciliation ─────────────────────────────────
    // Claim settlement requests stuck in 'processing' and resolve them
    // via Unipesa /status. Uses a separate claim RPC
    // (claim_pending_settlements) with its own cooldown.
    const SETTLEMENT_MIN_AGE_SECONDS = 300; // 5 min — longer than
    // transactions because settlements are lower-volume and we want
    // to give the callback more time to arrive.
    const SETTLEMENT_RETRY_AFTER_SECONDS = 300;

    const { data: settlementRows, error: settlementClaimErr } = await supabase.rpc(
      'claim_pending_settlements',
      {
        p_min_age_seconds: SETTLEMENT_MIN_AGE_SECONDS,
        p_max_age_seconds: MAX_AGE_SECONDS,
        p_batch_size: BATCH_SIZE,
        p_retry_after_seconds: SETTLEMENT_RETRY_AFTER_SECONDS,
      },
    );

    if (settlementClaimErr) {
      log.error(
        { event: 'settlement_claim_failed', err: settlementClaimErr.message },
        'claim_pending_settlements RPC failed',
      );
      return;
    }

    const claimedSettlements = (settlementRows as PendingSettlement[] | null) ?? [];
    if (claimedSettlements.length > 0) {
      let sSucceeded = 0;
      let sFailed = 0;
      for (const s of claimedSettlements) {
        try {
          await reconcileOneSettlement(supabase, s, log);
          sSucceeded += 1;
        } catch (err) {
          sFailed += 1;
          log.error(
            {
              event: 'settlement_reconciliation_failed',
              settlementId: s.id,
              errorCode: (err as Error)?.message,
            },
            'reconcileOneSettlement threw',
          );
        }
      }
      log.info(
        {
          event: 'settlement_reconciliation_completed',
          claimed: claimedSettlements.length,
          succeeded: sSucceeded,
          failed: sFailed,
          latencyMs: Date.now() - tickStart,
        },
        'settlement reconciliation tick complete',
      );
    }
  } finally {
    await releaseLock(supabase, log);
  }
}

/**
 * Start the reconciliation loop. Follows the same pattern as
 * startOnchainReconciler (services/onchain-reconciliation.ts):
 *   - guards against overlapping ticks with a `running` flag
 *   - fires an initial tick after a 30s stagger (so we don't pile
 *     work on top of boot-time recovery jobs)
 *   - setInterval with .unref() so the timer doesn't keep the
 *     process alive on shutdown
 */
export function startUnipesaReconciler(
  supabase: SupabaseClient,
  log: ReconciliationLogger,
  intervalMs = 60_000,
): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runReconciliationTick(supabase, log);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    void run().catch((err) =>
      log.error({ event: 'reconciliation_tick_crashed', err: (err as Error)?.message }),
    );
  }, 30_000).unref();

  setInterval(() => {
    void run().catch((err) =>
      log.error({ event: 'reconciliation_tick_crashed', err: (err as Error)?.message }),
    );
  }, intervalMs).unref();

  log.info({ event: 'reconciliation_loop_started', intervalMs }, 'unipesa reconciliation loop started');
}
