"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function source(relativePath) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), relativePath), 'utf8');
}
(0, node_test_1.describe)('Unipesa reconciliation — migration', () => {
    const migration = source('supabase/migrations/20260914000000_unipesa_reconciliation.sql');
    (0, node_test_1.it)('creates a worker_locks table with a TTL-based lock', () => {
        strict_1.default.match(migration, /CREATE TABLE IF NOT EXISTS public\.worker_locks/);
        strict_1.default.match(migration, /worker_name\s+TEXT PRIMARY KEY/);
        strict_1.default.match(migration, /expires_at\s+TIMESTAMPTZ NOT NULL/);
    });
    (0, node_test_1.it)('defines try_acquire_worker_lock with TTL and conflict-steal semantics', () => {
        strict_1.default.match(migration, /FUNCTION public\.try_acquire_worker_lock/);
        // ON CONFLICT DO UPDATE only when the existing lock has expired
        strict_1.default.match(migration, /ON CONFLICT \(worker_name\) DO UPDATE/);
        strict_1.default.match(migration, /WHERE public\.worker_locks\.expires_at < v_now/);
        // Returns true only if our timestamp is the one persisted
        strict_1.default.match(migration, /RETURN EXISTS/);
    });
    (0, node_test_1.it)('defines release_worker_lock that deletes the lock row', () => {
        strict_1.default.match(migration, /FUNCTION public\.release_worker_lock/);
        strict_1.default.match(migration, /DELETE FROM public\.worker_locks WHERE worker_name = p_worker_name/);
    });
    (0, node_test_1.it)('revokes worker lock RPCs from PUBLIC and grants only to service_role', () => {
        strict_1.default.match(migration, /REVOKE ALL ON FUNCTION public\.try_acquire_worker_lock\(TEXT, INTEGER\) FROM PUBLIC/);
        strict_1.default.match(migration, /REVOKE ALL ON FUNCTION public\.release_worker_lock\(TEXT\) FROM PUBLIC/);
        strict_1.default.match(migration, /GRANT EXECUTE ON FUNCTION public\.try_acquire_worker_lock\(TEXT, INTEGER\) TO service_role/);
        strict_1.default.match(migration, /GRANT EXECUTE ON FUNCTION public\.release_worker_lock\(TEXT\) TO service_role/);
    });
    (0, node_test_1.it)('adds reconcile_attempted_at column to transactions', () => {
        strict_1.default.match(migration, /ALTER TABLE public\.transactions\s+ADD COLUMN IF NOT EXISTS reconcile_attempted_at TIMESTAMPTZ/);
    });
    (0, node_test_1.it)('creates a partial index on processing transactions for efficient claiming', () => {
        strict_1.default.match(migration, /CREATE INDEX IF NOT EXISTS transactions_pending_reconcile_idx/);
        strict_1.default.match(migration, /WHERE status = 'processing'/);
    });
    (0, node_test_1.it)('defines claim_pending_unipay_transactions with FOR UPDATE SKIP LOCKED', () => {
        strict_1.default.match(migration, /FUNCTION public\.claim_pending_unipay_transactions/);
        strict_1.default.match(migration, /FOR UPDATE SKIP LOCKED/);
        // Filters on TEXT status 'processing', not INTEGER 1
        strict_1.default.match(migration, /status = 'processing'/);
        // Age guards: min_age and max_age
        strict_1.default.match(migration, /created_at <= now\(\) - make_interval\(secs => p_min_age_seconds\)/);
        strict_1.default.match(migration, /created_at >= now\(\) - make_interval\(secs => p_max_age_seconds\)/);
        // Retry cooldown
        strict_1.default.match(migration, /reconcile_attempted_at IS NULL/);
        strict_1.default.match(migration, /reconcile_attempted_at < now\(\) - make_interval\(secs => p_retry_after_seconds\)/);
        // Stamps reconcile_attempted_at on claim
        strict_1.default.match(migration, /SET reconcile_attempted_at = now\(\)/);
    });
    (0, node_test_1.it)('revokes claim RPC from PUBLIC and grants only to service_role', () => {
        strict_1.default.match(migration, /REVOKE ALL ON FUNCTION public\.claim_pending_unipay_transactions\(INTEGER, INTEGER, INTEGER, INTEGER\) FROM PUBLIC/);
        strict_1.default.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_pending_unipay_transactions\(INTEGER, INTEGER, INTEGER, INTEGER\) TO service_role/);
    });
    (0, node_test_1.it)('enables RLS on worker_locks with service_role-only policy', () => {
        strict_1.default.match(migration, /ALTER TABLE public\.worker_locks ENABLE ROW LEVEL SECURITY/);
        strict_1.default.match(migration, /CREATE POLICY worker_locks_service_role_all/);
        strict_1.default.match(migration, /FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/);
    });
});
(0, node_test_1.describe)('Unipesa reconciliation — service', () => {
    const service = source('src/services/unipesa-reconciliation.ts');
    (0, node_test_1.it)('uses a worker-level lock to prevent concurrent ticks across instances', () => {
        strict_1.default.match(service, /try_acquire_worker_lock/);
        strict_1.default.match(service, /releaseLock/);
        // Skips the tick if the lock is already held
        strict_1.default.match(service, /reconciliation skipped: lock already held/);
    });
    (0, node_test_1.it)('uses claim_pending_unipay_transactions for row-level claiming', () => {
        strict_1.default.match(service, /claim_pending_unipay_transactions/);
    });
    (0, node_test_1.it)('respects MIN_AGE_SECONDS to avoid racing with inbound callbacks', () => {
        strict_1.default.match(service, /MIN_AGE_SECONDS = 90/);
    });
    (0, node_test_1.it)('respects MAX_AGE_SECONDS to stop polling stale transactions', () => {
        strict_1.default.match(service, /MAX_AGE_SECONDS = 7 \* 24 \* 60 \* 60/);
    });
    (0, node_test_1.it)('logs transactions that exceed MAX_AGE_SECONDS for manual investigation', () => {
        strict_1.default.match(service, /transaction_too_old_for_reconcile/);
        strict_1.default.match(service, /manual investigation required/);
    });
    (0, node_test_1.it)('uses process_wallet_provider_callback for atomic resolution (no duplicate balance logic)', () => {
        strict_1.default.match(service, /process_wallet_provider_callback/);
        // Does NOT directly update wallet_users balance (the RPC handles it)
        strict_1.default.doesNotMatch(service, /UPDATE.*wallet_users.*balance/);
        strict_1.default.doesNotMatch(service, /\.from\('wallet_users'\)\.update/);
    });
    (0, node_test_1.it)('uses a unique provider_event_id per transaction+status for idempotency', () => {
        // The provider_event_id includes the transaction id and target status,
        // so a retry or a race with a callback produces a duplicate (not a
        // double application).
        strict_1.default.match(service, /reconcile:\$\{tx\.id\}:\$\{dbStatus\}/);
    });
    (0, node_test_1.it)('uses getTransactionStatusWithRaw from avada.ts (captures raw diagnostic data)', () => {
        strict_1.default.match(service, /from '\.\/avada'/);
        strict_1.default.match(service, /getTransactionStatusWithRaw/);
    });
    (0, node_test_1.it)('notifies the merchant webhook after successful reconciliation', () => {
        strict_1.default.match(service, /from '\.\.\/lib\/merchant-webhook'/);
        strict_1.default.match(service, /notifyMerchantWebhook/);
        // Only fires when the RPC returned processed: true (not on duplicate/already_terminal)
        strict_1.default.match(service, /if \(tx\.merchant_id\)/);
    });
    (0, node_test_1.it)('captures result.code and provider_result from raw Unipesa /status response', () => {
        strict_1.default.match(service, /rawResponse\['result'\]/);
        strict_1.default.match(service, /rawResponse\['provider_result'\]/);
        strict_1.default.match(service, /reconciledPayload\['result'\]/);
        strict_1.default.match(service, /reconciledPayload\['provider_result'\]/);
    });
    (0, node_test_1.it)('only resolves terminal statuses (success/failed), skips pending/processing', () => {
        strict_1.default.match(service, /remoteStatusRaw === 'pending' || remoteStatusRaw === 'processing'/);
        strict_1.default.match(service, /still pending upstream/);
    });
    (0, node_test_1.it)('maps cancelled to failed (same as the callback route)', () => {
        strict_1.default.match(service, /remoteStatusRaw === 'failed' || remoteStatusRaw === 'cancelled' \? 'failed'/);
    });
    (0, node_test_1.it)('follows the same startup pattern as startOnchainReconciler (running flag + unref)', () => {
        strict_1.default.match(service, /let running = false/);
        strict_1.default.match(service, /if \(running\) return/);
        strict_1.default.match(service, /\.unref\(\)/);
        // 30s stagger on first tick
        strict_1.default.match(service, /setTimeout\(/);
        strict_1.default.match(service, /30_000\)\.unref\(\)/);
    });
    (0, node_test_1.it)('exports both runReconciliationTick and startUnipesaReconciler', () => {
        strict_1.default.match(service, /export async function runReconciliationTick/);
        strict_1.default.match(service, /export function startUnipesaReconciler/);
    });
});
(0, node_test_1.describe)('Unipesa reconciliation — settlement fallback', () => {
    const service = source('src/services/unipesa-reconciliation.ts');
    (0, node_test_1.it)('runs claim_pending_settlements even when no transactions were claimed', () => {
        // Regression: the tick used to `return` early when claimed.length === 0,
        // which skipped the settlement claim section entirely — settlements
        // stuck in 'processing' were never reconciled.
        strict_1.default.doesNotMatch(service, /claimed\.length === 0[\s\S]{0,300}\breturn\b/);
        strict_1.default.match(service, /if \(claimed\.length > 0\)/);
        const txDone = service.indexOf('reconciliation tick complete (transactions)');
        const settlementClaim = service.indexOf('claim_pending_settlements');
        strict_1.default.ok(txDone > 0 && settlementClaim > txDone, 'settlement claim must run after the transaction loop, unconditionally');
    });
    (0, node_test_1.it)('falls back to direct settlement RPCs when the linked tx is already terminal', () => {
        // Covers the case where the tx was resolved while the settlement
        // propagation block was missing from process_wallet_provider_callback:
        // the RPC returns already_terminal and skips the settlement. The worker
        // must then call mark_settlement_* directly instead of re-claiming
        // forever.
        strict_1.default.match(service, /result\?\.already_terminal && !result\?\.processed/);
        strict_1.default.match(service, /mark_settlement_success/);
        strict_1.default.match(service, /mark_settlement_failed/);
        strict_1.default.match(service, /already_terminal_direct/);
    });
});
(0, node_test_1.describe)('reconcileOneSettlement — already_terminal fallback (functional)', () => {
    // env.ts exits the process when required vars are missing — stub them
    // before importing the service module.
    process.env.SUPABASE_URL ??= 'http://localhost';
    process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
    process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';
    const silentLog = { info: () => { }, warn: () => { }, error: () => { } };
    const settlement = {
        id: 'stl-test-1',
        merchant_id: 'm-1',
        amount: 19950,
        currency: 'CDF',
        phone: '+243970967029',
        provider_ref: 'STL-TEST',
        created_at: '2026-09-16T16:09:19Z',
    };
    function mockSupabase(linkedTx, callbackResult) {
        const rpcCalls = [];
        const supabase = {
            from: () => ({
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: linkedTx, error: null }) }) }),
            }),
            rpc: async (fn, params) => {
                rpcCalls.push({ fn, params });
                if (fn === 'process_wallet_provider_callback')
                    return { data: callbackResult, error: null };
                return { data: { ok: true }, error: null };
            },
        };
        return { supabase, rpcCalls };
    }
    (0, node_test_1.it)('tx already failed + settlement processing → mark_settlement_failed', async () => {
        const { reconcileOneSettlement } = await Promise.resolve().then(() => __importStar(require('../../services/unipesa-reconciliation')));
        const { supabase, rpcCalls } = mockSupabase({ id: 'tx-1', status: 'failed' }, { processed: false, already_terminal: true });
        await reconcileOneSettlement(supabase, settlement, silentLog, async () => ({ status: 'failed', raw: {} }));
        const mark = rpcCalls.find((c) => c.fn === 'mark_settlement_failed');
        strict_1.default.ok(mark, 'mark_settlement_failed must be called');
        strict_1.default.equal(mark.params.p_request_id, 'stl-test-1');
        strict_1.default.match(String(mark.params.p_reason), /linked transaction already failed/);
        strict_1.default.equal(rpcCalls.filter((c) => c.fn === 'mark_settlement_success').length, 0);
    });
    (0, node_test_1.it)('tx already success + settlement processing → mark_settlement_success', async () => {
        const { reconcileOneSettlement } = await Promise.resolve().then(() => __importStar(require('../../services/unipesa-reconciliation')));
        const { supabase, rpcCalls } = mockSupabase({ id: 'tx-2', status: 'success' }, { processed: false, already_terminal: true });
        await reconcileOneSettlement(supabase, settlement, silentLog, async () => ({ status: 'success', raw: {} }));
        const mark = rpcCalls.find((c) => c.fn === 'mark_settlement_success');
        strict_1.default.ok(mark, 'mark_settlement_success must be called');
        strict_1.default.equal(mark.params.p_request_id, 'stl-test-1');
        strict_1.default.equal(mark.params.p_provider_ref, 'STL-TEST');
        strict_1.default.equal(rpcCalls.filter((c) => c.fn === 'mark_settlement_failed').length, 0);
    });
    (0, node_test_1.it)('tx processing (RPC processed the resolution) → no direct settlement RPC', async () => {
        const { reconcileOneSettlement } = await Promise.resolve().then(() => __importStar(require('../../services/unipesa-reconciliation')));
        const { supabase, rpcCalls } = mockSupabase({ id: 'tx-3', status: 'processing' }, { processed: true });
        await reconcileOneSettlement(supabase, settlement, silentLog, async () => ({ status: 'failed', raw: {} }));
        strict_1.default.equal(rpcCalls.filter((c) => c.fn.startsWith('mark_settlement')).length, 0, 'fallback must not fire when the RPC processed normally');
    });
});
(0, node_test_1.describe)('Unipesa reconciliation — app.ts wiring', () => {
    const app = source('src/app.ts');
    (0, node_test_1.it)('imports startUnipesaReconciler', () => {
        strict_1.default.match(app, /import \{ startUnipesaReconciler \} from '\.\/services\/unipesa-reconciliation'/);
    });
    (0, node_test_1.it)('starts the reconciler after the onchain reconciler', () => {
        const onchainIdx = app.indexOf('startOnchainReconciler');
        const unipesaIdx = app.indexOf('startUnipesaReconciler');
        strict_1.default.ok(onchainIdx >= 0, 'startOnchainReconciler should be called');
        strict_1.default.ok(unipesaIdx > onchainIdx, 'startUnipesaReconciler should be called after startOnchainReconciler');
    });
});
(0, node_test_1.describe)('Unipesa reconciliation — idempotency guarantees', () => {
    const migration = source('supabase/migrations/20260906010000_provider_atomicity_idempotency.sql');
    const callbackMigration = source('supabase/migrations/20260908000100_callback_ledger_currency.sql');
    const service = source('src/services/unipesa-reconciliation.ts');
    (0, node_test_1.it)('process_wallet_provider_callback uses UNIQUE(provider, provider_event_id) for idempotency', () => {
        // The provider_webhook_events table has a UNIQUE constraint
        strict_1.default.match(migration, /CONSTRAINT provider_webhook_events_provider_event_uq UNIQUE \(provider, provider_event_id\)/);
        // The callback RPC returns 'duplicate' when the insert conflicts
        strict_1.default.match(callbackMigration, /ON CONFLICT \(provider, provider_event_id\) DO NOTHING/);
        strict_1.default.match(callbackMigration, /RETURN jsonb_build_object\('processed', false, 'duplicate', true\)/);
    });
    (0, node_test_1.it)('the reconciliation worker does not bypass the idempotency layer', () => {
        // The worker calls process_wallet_provider_callback, which does the
        // idempotent insert. The worker does NOT directly update balances.
        strict_1.default.match(service, /process_wallet_provider_callback/);
        strict_1.default.doesNotMatch(service, /wallet_credit_cdf/);
        strict_1.default.doesNotMatch(service, /wallet_debit/);
        strict_1.default.doesNotMatch(service, /merchant_ledger_entries/);
    });
    (0, node_test_1.it)('a callback and a reconciliation tick racing on the same transaction cannot double-apply', () => {
        // Both the callback route and the reconciliation worker call
        // process_wallet_provider_callback with a provider_event_id. If they
        // use the same id, one gets 'duplicate'. If they use different ids,
        // the second call finds the transaction already terminal and returns
        // 'already_terminal'. Either way, no double credit/refund.
        const callback = source('src/routes/payment/callback.ts');
        strict_1.default.match(callback, /process_wallet_provider_callback/);
        strict_1.default.match(service, /process_wallet_provider_callback/);
        // The callback route checks for already-terminal status
        strict_1.default.match(callbackMigration, /IF v_tx\.status IN \('success', 'failed', 'cancelled'\) THEN/);
        strict_1.default.match(callbackMigration, /RETURN jsonb_build_object\('processed', false, 'already_terminal', true\)/);
    });
});
//# sourceMappingURL=unipesa-reconciliation.test.js.map