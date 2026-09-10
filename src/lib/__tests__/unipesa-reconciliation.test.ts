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
