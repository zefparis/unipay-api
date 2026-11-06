"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * M4 remediation tests — atomic wallet reconciliation (anti double-credit).
 *
 * Verifies:
 *   - Migration creates wallet_reconcile_atomic RPC
 *   - RPC is SECURITY DEFINER, locks with FOR UPDATE
 *   - RPC is idempotent (already terminal → no-op, no double-credit)
 *   - RPC updates status + credits balance atomically
 *   - wallet-reconcile.ts uses the new RPC instead of separate check + credit
 *   - No TOCTOU: the check and credit are in a single RPC call
 *   - Idempotent return for already-terminal transactions
 *   - logAdminAction is called (audit trail — M2)
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const RECONCILE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/admin/wallet-reconcile.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260926000000_atomic_wallet_reconcile.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('M4-migration — wallet_reconcile_atomic RPC', () => {
    (0, node_test_1.it)('creates the RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_reconcile_atomic/i);
    });
    (0, node_test_1.it)('is SECURITY DEFINER', () => {
        strict_1.default.match(MIGRATION, /wallet_reconcile_atomic[\s\S]*?SECURITY DEFINER/);
    });
    (0, node_test_1.it)('accepts p_tx_id, p_target_status, p_delta parameters', () => {
        strict_1.default.match(MIGRATION, /p_tx_id\s+UUID/);
        strict_1.default.match(MIGRATION, /p_target_status\s+TEXT/);
        strict_1.default.match(MIGRATION, /p_delta\s+NUMERIC/);
    });
    (0, node_test_1.it)('locks the transaction row with FOR UPDATE', () => {
        strict_1.default.match(MIGRATION, /wallet_reconcile_atomic[\s\S]*?FOR UPDATE/);
    });
    (0, node_test_1.it)('checks if status is already terminal (idempotence)', () => {
        strict_1.default.match(MIGRATION, /already_terminal/);
        strict_1.default.match(MIGRATION, /v_tx\.status = 'success' OR v_tx\.status = 'failed'/);
    });
    (0, node_test_1.it)('returns already_terminal=true without crediting on terminal status', () => {
        // The already_terminal branch must return before any balance update
        strict_1.default.match(MIGRATION, /already_terminal[\s\S]*?RETURN jsonb_build_object/);
    });
    (0, node_test_1.it)('updates transaction status atomically', () => {
        strict_1.default.match(MIGRATION, /UPDATE public\.transactions\s+SET status = p_target_status/);
    });
    (0, node_test_1.it)('credits wallet balance inside the same transaction', () => {
        strict_1.default.match(MIGRATION, /UPDATE public\.wallet_users\s+SET balance_cdf = balance_cdf \+ p_delta/);
    });
    (0, node_test_1.it)('raises TRANSACTION_NOT_FOUND when tx does not exist', () => {
        strict_1.default.match(MIGRATION, /TRANSACTION_NOT_FOUND/);
    });
    (0, node_test_1.it)('raises WALLET_NOT_FOUND when wallet does not exist', () => {
        strict_1.default.match(MIGRATION, /WALLET_NOT_FOUND/);
    });
    (0, node_test_1.it)('raises INVALID_TARGET_STATUS for invalid status', () => {
        strict_1.default.match(MIGRATION, /INVALID_TARGET_STATUS/);
    });
    (0, node_test_1.it)('grants EXECUTE to service_role', () => {
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_reconcile_atomic\(UUID, TEXT, NUMERIC\) TO service_role/);
    });
});
// ── wallet-reconcile.ts tests ────────────────────────────────
(0, node_test_1.describe)('M4-reconcile — uses atomic RPC (no TOCTOU)', () => {
    (0, node_test_1.it)('calls wallet_reconcile_atomic RPC', () => {
        strict_1.default.match(RECONCILE, /wallet_reconcile_atomic/);
    });
    (0, node_test_1.it)('passes p_tx_id, p_target_status, p_delta', () => {
        strict_1.default.match(RECONCILE, /p_tx_id:\s*tx\.id/);
        strict_1.default.match(RECONCILE, /p_target_status:\s*targetStatus/);
        strict_1.default.match(RECONCILE, /p_delta:\s*delta/);
    });
    (0, node_test_1.it)('handles already_terminal idempotent return', () => {
        strict_1.default.match(RECONCILE, /already_terminal/);
        strict_1.default.match(RECONCILE, /Already/);
    });
    (0, node_test_1.it)('handles TRANSACTION_NOT_FOUND error (404)', () => {
        strict_1.default.match(RECONCILE, /TRANSACTION_NOT_FOUND/);
        strict_1.default.match(RECONCILE, /404/);
    });
    (0, node_test_1.it)('handles WALLET_NOT_FOUND error (404)', () => {
        strict_1.default.match(RECONCILE, /WALLET_NOT_FOUND/);
        strict_1.default.match(RECONCILE, /404/);
    });
    (0, node_test_1.it)('does NOT call wallet_credit_cdf directly (old TOCTOU path)', () => {
        // The old code called wallet_credit_cdf separately after the status
        // check. The new code does both atomically in the RPC.
        // Strip comments before checking.
        const stripped = RECONCILE
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        strict_1.default.doesNotMatch(stripped, /rpc\('wallet_credit_cdf'/);
    });
    (0, node_test_1.it)('does NOT do a separate status check + early return before the RPC', () => {
        // The old code did: if (tx.status === 'success' || tx.status === 'failed') return ...
        // BEFORE calling the credit RPC. The new code delegates this check to
        // the atomic RPC (which does it under FOR UPDATE lock).
        // Strip comments before checking.
        const stripped = RECONCILE
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        // Should not find the old pattern of checking tx.status then returning early
        strict_1.default.doesNotMatch(stripped, /if \(tx\.status === 'success' \|\| tx\.status === 'failed'\)\s*\{[\s\S]*?return reply/);
    });
    (0, node_test_1.it)('the atomic RPC call happens BEFORE logAdminAction', () => {
        // The debit must happen before the audit log (the log records the result).
        // Find the logAdminAction CALL (not the import).
        const rpcPos = RECONCILE.indexOf('wallet_reconcile_atomic');
        const logPos = RECONCILE.indexOf("void logAdminAction(");
        strict_1.default.ok(rpcPos > -1, 'must find atomic RPC call');
        strict_1.default.ok(logPos > -1, 'must find logAdminAction call');
        strict_1.default.ok(rpcPos < logPos, 'atomic RPC must run BEFORE logAdminAction');
    });
    (0, node_test_1.it)('logs via logAdminAction with reconcile details', () => {
        strict_1.default.match(RECONCILE, /logAdminAction\([\s\S]*?'wallet\.reconcile'/);
        strict_1.default.match(RECONCILE, /logAdminAction\([\s\S]*?'transaction'/);
        strict_1.default.match(RECONCILE, /logAdminAction\([\s\S]*?previous_status/);
        strict_1.default.match(RECONCILE, /logAdminAction\([\s\S]*?new_status/);
    });
});
//# sourceMappingURL=m4-atomic-reconcile.test.js.map