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
 * M3 remediation tests — atomic KYC daily limit + balance debit.
 *
 * Verifies:
 *   - Migration creates wallet_debit_with_kyc_limit RPC
 *   - RPC is SECURITY DEFINER, locks with FOR UPDATE
 *   - RPC checks daily limit, balance, and debits atomically
 *   - withdraw.ts uses the new RPC instead of separate check + debit
 *   - No TOCTOU: the check and debit are in a single RPC call
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const WITHDRAW = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/withdraw.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260925000000_atomic_kyc_limit.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('M3-migration — wallet_debit_with_kyc_limit RPC', () => {
    (0, node_test_1.it)('creates the RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_debit_with_kyc_limit/i);
    });
    (0, node_test_1.it)('is SECURITY DEFINER', () => {
        strict_1.default.match(MIGRATION, /wallet_debit_with_kyc_limit[\s\S]*?SECURITY DEFINER/);
    });
    (0, node_test_1.it)('accepts p_user_id, p_amount, p_daily_limit parameters', () => {
        strict_1.default.match(MIGRATION, /p_user_id\s+UUID/);
        strict_1.default.match(MIGRATION, /p_amount\s+NUMERIC/);
        strict_1.default.match(MIGRATION, /p_daily_limit\s+NUMERIC/);
    });
    (0, node_test_1.it)('locks the wallet row with FOR UPDATE', () => {
        strict_1.default.match(MIGRATION, /wallet_debit_with_kyc_limit[\s\S]*?FOR UPDATE/);
    });
    (0, node_test_1.it)('computes daily cumulative payout from transactions', () => {
        strict_1.default.match(MIGRATION, /direction = 'payout'/);
        strict_1.default.match(MIGRATION, /status IN \('processing', 'success'\)/);
        strict_1.default.match(MIGRATION, /date_trunc\('day', now\(\)\)/);
    });
    (0, node_test_1.it)('raises KYC_LIMIT_EXCEEDED when daily limit exceeded', () => {
        strict_1.default.match(MIGRATION, /KYC_LIMIT_EXCEEDED/);
    });
    (0, node_test_1.it)('raises INSUFFICIENT_FUNDS when balance too low', () => {
        strict_1.default.match(MIGRATION, /INSUFFICIENT_FUNDS/);
    });
    (0, node_test_1.it)('raises WALLET_SUSPENDED when account inactive', () => {
        strict_1.default.match(MIGRATION, /WALLET_SUSPENDED/);
    });
    (0, node_test_1.it)('raises WALLET_NOT_FOUND when wallet does not exist', () => {
        strict_1.default.match(MIGRATION, /WALLET_NOT_FOUND/);
    });
    (0, node_test_1.it)('debits balance_cdf atomically', () => {
        strict_1.default.match(MIGRATION, /balance_cdf = v_new_balance/);
        strict_1.default.match(MIGRATION, /v_new_balance := v_wallet\.balance_cdf - p_amount/);
    });
    (0, node_test_1.it)('returns JSONB with new_balance and daily_used', () => {
        strict_1.default.match(MIGRATION, /jsonb_build_object/);
        strict_1.default.match(MIGRATION, /new_balance/);
        strict_1.default.match(MIGRATION, /daily_used_before/);
        strict_1.default.match(MIGRATION, /daily_used_after/);
    });
    (0, node_test_1.it)('grants EXECUTE to service_role', () => {
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_debit_with_kyc_limit TO service_role/);
    });
});
// ── withdraw.ts tests ────────────────────────────────────────
(0, node_test_1.describe)('M3-withdraw — uses atomic RPC (no TOCTOU)', () => {
    (0, node_test_1.it)('calls wallet_debit_with_kyc_limit RPC', () => {
        strict_1.default.match(WITHDRAW, /wallet_debit_with_kyc_limit/);
    });
    (0, node_test_1.it)('passes p_daily_limit from KYC limits', () => {
        strict_1.default.match(WITHDRAW, /p_daily_limit:\s*limits\.withdraw_daily/);
    });
    (0, node_test_1.it)('handles KYC_LIMIT_EXCEEDED error (403)', () => {
        strict_1.default.match(WITHDRAW, /KYC_LIMIT_EXCEEDED/);
        strict_1.default.match(WITHDRAW, /403/);
    });
    (0, node_test_1.it)('handles INSUFFICIENT_FUNDS error (402)', () => {
        strict_1.default.match(WITHDRAW, /INSUFFICIENT_FUNDS/);
        strict_1.default.match(WITHDRAW, /402/);
    });
    (0, node_test_1.it)('handles WALLET_SUSPENDED error (403)', () => {
        strict_1.default.match(WITHDRAW, /WALLET_SUSPENDED/);
        strict_1.default.match(WITHDRAW, /403/);
    });
    (0, node_test_1.it)('does NOT call the old wallet_debit RPC', () => {
        // The old wallet_debit RPC should no longer be called — the new
        // RPC does both the KYC check and the debit atomically.
        // Strip comments before checking.
        const stripped = WITHDRAW
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        strict_1.default.doesNotMatch(stripped, /rpc\('wallet_debit'/);
    });
    (0, node_test_1.it)('does NOT do a separate SELECT for daily cumulative (TOCTOU eliminated)', () => {
        // The old code did a separate SELECT to compute dailyUsed before
        // the debit. The new code does this inside the RPC atomically.
        // Strip comments before checking.
        const stripped = WITHDRAW
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        // Should not find the old pattern of selecting transactions to compute dailyUsed
        strict_1.default.doesNotMatch(stripped, /from\('transactions'\)[\s\S]*?\.eq\('direction', 'payout'\)[\s\S]*?dailyUsed/);
    });
    (0, node_test_1.it)('the atomic RPC call happens BEFORE the transaction insert', () => {
        // The debit must happen before the transaction insert (same as
        // the old flow — debit first, then insert the transaction record).
        const rpcPos = WITHDRAW.indexOf('wallet_debit_with_kyc_limit');
        const insertPos = WITHDRAW.indexOf("from('transactions')");
        strict_1.default.ok(rpcPos > -1, 'must find atomic RPC call');
        strict_1.default.ok(insertPos > -1, 'must find transaction insert');
        strict_1.default.ok(rpcPos < insertPos, 'atomic debit+KYC RPC must run BEFORE transaction insert');
    });
});
//# sourceMappingURL=m3-atomic-kyc-limit.test.js.map