/**
 * Tests for the Unipesa reconciliation worker.
 *
 * These are static-analysis tests (same style as the existing
 * atomic-wallet-balances.test.ts and security-definer-grants.test.ts)
 * that verify the migration SQL and the service code have the
 * required concurrency, idempotency, and age-guard properties.
 *
 * End-to-end verification against a live database is done separately
 * after deployment (see the production test in the deployment report).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('Unipesa reconciliation — migration', () => {
  const migration = source('supabase/migrations/20260914000000_unipesa_reconciliation.sql');

  it('creates a worker_locks table with a TTL-based lock', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.worker_locks/);
    assert.match(migration, /worker_name\s+TEXT PRIMARY KEY/);
    assert.match(migration, /expires_at\s+TIMESTAMPTZ NOT NULL/);
  });

  it('defines try_acquire_worker_lock with TTL and conflict-steal semantics', () => {
    assert.match(migration, /FUNCTION public\.try_acquire_worker_lock/);
    // ON CONFLICT DO UPDATE only when the existing lock has expired
    assert.match(migration, /ON CONFLICT \(worker_name\) DO UPDATE/);
    assert.match(migration, /WHERE public\.worker_locks\.expires_at < v_now/);
    // Returns true only if our timestamp is the one persisted
    assert.match(migration, /RETURN EXISTS/);
  });

  it('defines release_worker_lock that deletes the lock row', () => {
    assert.match(migration, /FUNCTION public\.release_worker_lock/);
    assert.match(migration, /DELETE FROM public\.worker_locks WHERE worker_name = p_worker_name/);
  });

  it('revokes worker lock RPCs from PUBLIC and grants only to service_role', () => {
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.try_acquire_worker_lock\(TEXT, INTEGER\) FROM PUBLIC/);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.release_worker_lock\(TEXT\) FROM PUBLIC/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.try_acquire_worker_lock\(TEXT, INTEGER\) TO service_role/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.release_worker_lock\(TEXT\) TO service_role/);
  });

  it('adds reconcile_attempted_at column to transactions', () => {
    assert.match(migration, /ALTER TABLE public\.transactions\s+ADD COLUMN IF NOT EXISTS reconcile_attempted_at TIMESTAMPTZ/);
  });

  it('creates a partial index on processing transactions for efficient claiming', () => {
    assert.match(migration, /CREATE INDEX IF NOT EXISTS transactions_pending_reconcile_idx/);
    assert.match(migration, /WHERE status = 'processing'/);
  });

  it('defines claim_pending_unipay_transactions with FOR UPDATE SKIP LOCKED', () => {
    assert.match(migration, /FUNCTION public\.claim_pending_unipay_transactions/);
    assert.match(migration, /FOR UPDATE SKIP LOCKED/);
    // Filters on TEXT status 'processing', not INTEGER 1
    assert.match(migration, /status = 'processing'/);
    // Age guards: min_age and max_age
    assert.match(migration, /created_at <= now\(\) - make_interval\(secs => p_min_age_seconds\)/);
    assert.match(migration, /created_at >= now\(\) - make_interval\(secs => p_max_age_seconds\)/);
    // Retry cooldown
    assert.match(migration, /reconcile_attempted_at IS NULL/);
    assert.match(migration, /reconcile_attempted_at < now\(\) - make_interval\(secs => p_retry_after_seconds\)/);
    // Stamps reconcile_attempted_at on claim
    assert.match(migration, /SET reconcile_attempted_at = now\(\)/);
  });

  it('revokes claim RPC from PUBLIC and grants only to service_role', () => {
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_pending_unipay_transactions\(INTEGER, INTEGER, INTEGER, INTEGER\) FROM PUBLIC/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_pending_unipay_transactions\(INTEGER, INTEGER, INTEGER, INTEGER\) TO service_role/);
  });

  it('enables RLS on worker_locks with service_role-only policy', () => {
    assert.match(migration, /ALTER TABLE public\.worker_locks ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /CREATE POLICY worker_locks_service_role_all/);
    assert.match(migration, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
  });
});

describe('Unipesa reconciliation — service', () => {
  const service = source('src/services/unipesa-reconciliation.ts');

  it('uses a worker-level lock to prevent concurrent ticks across instances', () => {
    assert.match(service, /try_acquire_worker_lock/);
    assert.match(service, /releaseLock/);
    // Skips the tick if the lock is already held
    assert.match(service, /reconciliation skipped: lock already held/);
  });

  it('uses claim_pending_unipay_transactions for row-level claiming', () => {
    assert.match(service, /claim_pending_unipay_transactions/);
  });

  it('respects MIN_AGE_SECONDS to avoid racing with inbound callbacks', () => {
    assert.match(service, /MIN_AGE_SECONDS = 90/);
  });

  it('respects MAX_AGE_SECONDS to stop polling stale transactions', () => {
    assert.match(service, /MAX_AGE_SECONDS = 7 \* 24 \* 60 \* 60/);
  });

  it('logs transactions that exceed MAX_AGE_SECONDS for manual investigation', () => {
    assert.match(service, /transaction_too_old_for_reconcile/);
    assert.match(service, /manual investigation required/);
  });

  it('uses process_wallet_provider_callback for atomic resolution (no duplicate balance logic)', () => {
    assert.match(service, /process_wallet_provider_callback/);
    // Does NOT directly update wallet_users balance (the RPC handles it)
    assert.doesNotMatch(service, /UPDATE.*wallet_users.*balance/);
    assert.doesNotMatch(service, /\.from\('wallet_users'\)\.update/);
  });

  it('uses a unique provider_event_id per transaction+status for idempotency', () => {
    // The provider_event_id includes the transaction id and target status,
    // so a retry or a race with a callback produces a duplicate (not a
    // double application).
    assert.match(service, /reconcile:\$\{tx\.id\}:\$\{dbStatus\}/);
  });

  it('uses getTransactionStatusWithRaw from avada.ts (captures raw diagnostic data)', () => {
    assert.match(service, /from '\.\/avada'/);
    assert.match(service, /getTransactionStatusWithRaw/);
  });

  it('notifies the merchant webhook after successful reconciliation', () => {
    assert.match(service, /from '\.\.\/lib\/merchant-webhook'/);
    assert.match(service, /notifyMerchantWebhook/);
    // Only fires when the RPC returned processed: true (not on duplicate/already_terminal)
    assert.match(service, /if \(tx\.merchant_id\)/);
  });

  it('captures result.code and provider_result from raw Unipesa /status response', () => {
    assert.match(service, /rawResponse\['result'\]/);
    assert.match(service, /rawResponse\['provider_result'\]/);
    assert.match(service, /reconciledPayload\['result'\]/);
    assert.match(service, /reconciledPayload\['provider_result'\]/);
  });

  it('only resolves terminal statuses (success/failed), skips pending/processing', () => {
    assert.match(service, /remoteStatusRaw === 'pending' || remoteStatusRaw === 'processing'/);
    assert.match(service, /still pending upstream/);
  });

  it('maps cancelled to failed (same as the callback route)', () => {
    assert.match(service, /remoteStatusRaw === 'failed' || remoteStatusRaw === 'cancelled' \? 'failed'/);
  });

  it('follows the same startup pattern as startOnchainReconciler (running flag + unref)', () => {
    assert.match(service, /let running = false/);
    assert.match(service, /if \(running\) return/);
    assert.match(service, /\.unref\(\)/);
    // 30s stagger on first tick
    assert.match(service, /setTimeout\(/);
    assert.match(service, /30_000\)\.unref\(\)/);
  });

  it('exports both runReconciliationTick and startUnipesaReconciler', () => {
    assert.match(service, /export async function runReconciliationTick/);
    assert.match(service, /export function startUnipesaReconciler/);
  });
});

describe('Unipesa reconciliation — settlement fallback', () => {
  const service = source('src/services/unipesa-reconciliation.ts');

  it('runs claim_pending_settlements even when no transactions were claimed', () => {
    // Regression: the tick used to `return` early when claimed.length === 0,
    // which skipped the settlement claim section entirely — settlements
    // stuck in 'processing' were never reconciled.
    assert.doesNotMatch(service, /claimed\.length === 0[\s\S]{0,300}\breturn\b/);
    assert.match(service, /if \(claimed\.length > 0\)/);
    const txDone = service.indexOf('reconciliation tick complete (transactions)');
    const settlementClaim = service.indexOf('claim_pending_settlements');
    assert.ok(txDone > 0 && settlementClaim > txDone,
      'settlement claim must run after the transaction loop, unconditionally');
  });

  it('falls back to direct settlement RPCs when the linked tx is already terminal', () => {
    // Covers the case where the tx was resolved while the settlement
    // propagation block was missing from process_wallet_provider_callback:
    // the RPC returns already_terminal and skips the settlement. The worker
    // must then call mark_settlement_* directly instead of re-claiming
    // forever.
    assert.match(service, /result\?\.already_terminal && !result\?\.processed/);
    assert.match(service, /mark_settlement_success/);
    assert.match(service, /mark_settlement_failed/);
    assert.match(service, /already_terminal_direct/);
  });
});

describe('reconcileOneSettlement — already_terminal fallback (functional)', () => {
  // env.ts exits the process when required vars are missing — stub them
  // before importing the service module.
  process.env.SUPABASE_URL ??= 'http://localhost';
  process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
  process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';

  const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

  const settlement = {
    id: 'stl-test-1',
    merchant_id: 'm-1',
    amount: 19950,
    currency: 'CDF',
    phone: '+243970967029',
    provider_ref: 'STL-TEST',
    created_at: '2026-09-16T16:09:19Z',
  };

  function mockSupabase(linkedTx: { id: string; status: string }, callbackResult: unknown) {
    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linkedTx, error: null }) }) }),
      }),
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        if (fn === 'process_wallet_provider_callback') return { data: callbackResult, error: null };
        return { data: { ok: true }, error: null };
      },
    };
    return { supabase, rpcCalls };
  }

  it('tx already failed + settlement processing → mark_settlement_failed', async () => {
    const { reconcileOneSettlement } = await import('../../services/unipesa-reconciliation');
    const { supabase, rpcCalls } = mockSupabase(
      { id: 'tx-1', status: 'failed' },
      { processed: false, already_terminal: true },
    );
    await reconcileOneSettlement(
      supabase as never,
      settlement,
      silentLog,
      async () => ({ status: 'failed', raw: {} }),
    );
    const mark = rpcCalls.find((c) => c.fn === 'mark_settlement_failed');
    assert.ok(mark, 'mark_settlement_failed must be called');
    assert.equal(mark!.params.p_request_id, 'stl-test-1');
    assert.match(String(mark!.params.p_reason), /linked transaction already failed/);
    assert.equal(rpcCalls.filter((c) => c.fn === 'mark_settlement_success').length, 0);
  });

  it('tx already success + settlement processing → mark_settlement_success', async () => {
    const { reconcileOneSettlement } = await import('../../services/unipesa-reconciliation');
    const { supabase, rpcCalls } = mockSupabase(
      { id: 'tx-2', status: 'success' },
      { processed: false, already_terminal: true },
    );
    await reconcileOneSettlement(
      supabase as never,
      settlement,
      silentLog,
      async () => ({ status: 'success', raw: {} }),
    );
    const mark = rpcCalls.find((c) => c.fn === 'mark_settlement_success');
    assert.ok(mark, 'mark_settlement_success must be called');
    assert.equal(mark!.params.p_request_id, 'stl-test-1');
    assert.equal(mark!.params.p_provider_ref, 'STL-TEST');
    assert.equal(rpcCalls.filter((c) => c.fn === 'mark_settlement_failed').length, 0);
  });

  it('tx processing (RPC processed the resolution) → no direct settlement RPC', async () => {
    const { reconcileOneSettlement } = await import('../../services/unipesa-reconciliation');
    const { supabase, rpcCalls } = mockSupabase(
      { id: 'tx-3', status: 'processing' },
      { processed: true },
    );
    await reconcileOneSettlement(
      supabase as never,
      settlement,
      silentLog,
      async () => ({ status: 'failed', raw: {} }),
    );
    assert.equal(rpcCalls.filter((c) => c.fn.startsWith('mark_settlement')).length, 0,
      'fallback must not fire when the RPC processed normally');
  });
});

describe('Unipesa reconciliation — app.ts wiring', () => {
  const app = source('src/app.ts');

  it('imports startUnipesaReconciler', () => {
    assert.match(app, /import \{ startUnipesaReconciler \} from '\.\/services\/unipesa-reconciliation'/);
  });

  it('starts the reconciler after the onchain reconciler', () => {
    const onchainIdx = app.indexOf('startOnchainReconciler');
    const unipesaIdx = app.indexOf('startUnipesaReconciler');
    assert.ok(onchainIdx >= 0, 'startOnchainReconciler should be called');
    assert.ok(unipesaIdx > onchainIdx, 'startUnipesaReconciler should be called after startOnchainReconciler');
  });
});

describe('Unipesa reconciliation — idempotency guarantees', () => {
  const migration = source('supabase/migrations/20260906010000_provider_atomicity_idempotency.sql');
  const callbackMigration = source('supabase/migrations/20260908000100_callback_ledger_currency.sql');
  const service = source('src/services/unipesa-reconciliation.ts');

  it('process_wallet_provider_callback uses UNIQUE(provider, provider_event_id) for idempotency', () => {
    // The provider_webhook_events table has a UNIQUE constraint
    assert.match(migration, /CONSTRAINT provider_webhook_events_provider_event_uq UNIQUE \(provider, provider_event_id\)/);
    // The callback RPC returns 'duplicate' when the insert conflicts
    assert.match(callbackMigration, /ON CONFLICT \(provider, provider_event_id\) DO NOTHING/);
    assert.match(callbackMigration, /RETURN jsonb_build_object\('processed', false, 'duplicate', true\)/);
  });

  it('the reconciliation worker does not bypass the idempotency layer', () => {
    // The worker calls process_wallet_provider_callback, which does the
    // idempotent insert. The worker does NOT directly update balances.
    assert.match(service, /process_wallet_provider_callback/);
    assert.doesNotMatch(service, /wallet_credit_cdf/);
    assert.doesNotMatch(service, /wallet_debit/);
    assert.doesNotMatch(service, /merchant_ledger_entries/);
  });

  it('a callback and a reconciliation tick racing on the same transaction cannot double-apply', () => {
    // Both the callback route and the reconciliation worker call
    // process_wallet_provider_callback with a provider_event_id. If they
    // use the same id, one gets 'duplicate'. If they use different ids,
    // the second call finds the transaction already terminal and returns
    // 'already_terminal'. Either way, no double credit/refund.
    const callback = source('src/routes/payment/callback.ts');
    assert.match(callback, /process_wallet_provider_callback/);
    assert.match(service, /process_wallet_provider_callback/);
    // The callback route checks for already-terminal status
    assert.match(callbackMigration, /IF v_tx\.status IN \('success', 'failed', 'cancelled'\) THEN/);
    assert.match(callbackMigration, /RETURN jsonb_build_object\('processed', false, 'already_terminal', true\)/);
  });
});
