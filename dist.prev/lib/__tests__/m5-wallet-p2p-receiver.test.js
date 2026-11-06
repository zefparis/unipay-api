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
 * M5 remediation tests — wallet_p2p receiver inactive check.
 *
 * The original wallet_p2p debited the sender (first UPDATE) then
 * credited the receiver (second UPDATE) WITHOUT checking IF NOT
 * FOUND on the second UPDATE. If the receiver was inactive
 * (is_active = false), the credit affected 0 rows silently — the
 * sender was debited, nobody was credited, funds disappeared.
 *
 * Fix: after the second UPDATE, check IF NOT FOUND and raise
 * RECEIVER_INACTIVE. In PL/pgSQL, an exception rolls back the
 * entire function (including the sender debit) — no funds lost.
 *
 * Tests verify:
 *   - Migration re-creates wallet_p2p with the IF NOT FOUND check
 *   - The check raises RECEIVER_INACTIVE
 *   - The function is SECURITY DEFINER (defense-in-depth)
 *   - p2p.ts handles RECEIVER_INACTIVE error (403)
 *   - The original INSUFFICIENT_FUNDS check is preserved
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const P2P = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/p2p.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260927000000_wallet_p2p_receiver_check.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('M5-migration — wallet_p2p receiver check', () => {
    (0, node_test_1.it)('re-creates wallet_p2p function', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_p2p/i);
    });
    (0, node_test_1.it)('is SECURITY DEFINER', () => {
        strict_1.default.match(MIGRATION, /wallet_p2p[\s\S]*?SECURITY DEFINER/);
    });
    (0, node_test_1.it)('sets search_path = public', () => {
        strict_1.default.match(MIGRATION, /wallet_p2p[\s\S]*?SET search_path = public/);
    });
    (0, node_test_1.it)('preserves the sender debit with INSUFFICIENT_FUNDS check', () => {
        strict_1.default.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf - p_amount/i);
        strict_1.default.match(MIGRATION, /WHERE id\s+= p_sender_id[\s\S]*?AND balance_cdf >= p_amount[\s\S]*?AND is_active = true/i);
        strict_1.default.match(MIGRATION, /IF NOT FOUND THEN\s+RAISE EXCEPTION 'INSUFFICIENT_FUNDS'/);
    });
    (0, node_test_1.it)('preserves the receiver credit', () => {
        strict_1.default.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf \+ p_amount/i);
        strict_1.default.match(MIGRATION, /WHERE id\s+= p_receiver_id[\s\S]*?AND is_active = true/i);
    });
    (0, node_test_1.it)('adds IF NOT FOUND check after receiver credit (M5 fix)', () => {
        // The fix: after the receiver credit UPDATE, check IF NOT FOUND
        // and raise RECEIVER_INACTIVE. This rolls back the sender debit.
        strict_1.default.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf \+ p_amount[\s\S]*?IF NOT FOUND THEN\s+RAISE EXCEPTION 'RECEIVER_INACTIVE'/);
    });
    (0, node_test_1.it)('raises RECEIVER_INACTIVE error', () => {
        strict_1.default.match(MIGRATION, /RECEIVER_INACTIVE/);
    });
    (0, node_test_1.it)('the RECEIVER_INACTIVE check comes AFTER the receiver credit UPDATE', () => {
        // Strip comment lines to find actual code positions
        const code = MIGRATION
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n');
        const creditPos = code.indexOf('balance_cdf = balance_cdf + p_amount');
        const checkPos = code.indexOf("RECEIVER_INACTIVE");
        strict_1.default.ok(creditPos > -1, 'must find receiver credit UPDATE');
        strict_1.default.ok(checkPos > -1, 'must find RECEIVER_INACTIVE check');
        strict_1.default.ok(creditPos < checkPos, 'RECEIVER_INACTIVE check must come AFTER the receiver credit');
    });
    (0, node_test_1.it)('the RECEIVER_INACTIVE check comes AFTER the INSUFFICIENT_FUNDS check', () => {
        // Strip comment lines to find actual code positions
        const code = MIGRATION
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n');
        const insufficientPos = code.indexOf("INSUFFICIENT_FUNDS");
        const inactivePos = code.indexOf("RECEIVER_INACTIVE");
        strict_1.default.ok(insufficientPos > -1);
        strict_1.default.ok(inactivePos > -1);
        strict_1.default.ok(insufficientPos < inactivePos, 'INSUFFICIENT_FUNDS check (sender) must come BEFORE RECEIVER_INACTIVE check (receiver)');
    });
    (0, node_test_1.it)('revokes PUBLIC and grants service_role', () => {
        strict_1.default.match(MIGRATION, /REVOKE ALL ON FUNCTION public\.wallet_p2p\(uuid, uuid, numeric\) FROM PUBLIC/);
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_p2p\(uuid, uuid, numeric\) TO service_role/);
    });
});
// ── p2p.ts tests ─────────────────────────────────────────────
(0, node_test_1.describe)('M5-p2p — handles RECEIVER_INACTIVE error', () => {
    (0, node_test_1.it)('handles RECEIVER_INACTIVE error (403)', () => {
        strict_1.default.match(P2P, /RECEIVER_INACTIVE/);
        strict_1.default.match(P2P, /403/);
    });
    (0, node_test_1.it)('returns "Recipient account is suspended" for RECEIVER_INACTIVE', () => {
        strict_1.default.match(P2P, /Recipient account is suspended/);
    });
    (0, node_test_1.it)('preserves INSUFFICIENT_FUNDS handling (402)', () => {
        strict_1.default.match(P2P, /INSUFFICIENT_FUNDS/);
        strict_1.default.match(P2P, /402/);
    });
    (0, node_test_1.it)('RECEIVER_INACTIVE check comes before the generic fallback', () => {
        // The RECEIVER_INACTIVE check must come before the generic
        // isInsufficient ? 402 : 500 fallback.
        const inactivePos = P2P.indexOf('RECEIVER_INACTIVE');
        const fallbackPos = P2P.indexOf("isInsufficient ? 402 : 500");
        strict_1.default.ok(inactivePos > -1);
        strict_1.default.ok(fallbackPos > -1);
        strict_1.default.ok(inactivePos < fallbackPos, 'RECEIVER_INACTIVE check must come before the generic fallback');
    });
});
//# sourceMappingURL=m5-wallet-p2p-receiver.test.js.map