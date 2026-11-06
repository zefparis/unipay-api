"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function source(relativePath) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), relativePath), 'utf8');
}
(0, node_test_1.describe)('atomic wallet balance guards', () => {
    const migration = source('supabase/migrations/20260906000000_atomic_wallet_balance_rpcs.sql');
    (0, node_test_1.it)('defines guarded USDT and CGLT debits that fail when no row is updated', () => {
        strict_1.default.match(migration, /FUNCTION public\.wallet_debit_usdt/);
        strict_1.default.match(migration, /usdt_balance >= p_amount[\s\S]*RETURNING usdt_balance INTO v_new_balance;[\s\S]*IF NOT FOUND THEN[\s\S]*INSUFFICIENT_USDT/);
        strict_1.default.match(migration, /FUNCTION public\.wallet_debit_cglt/);
        strict_1.default.match(migration, /cglt_balance >= p_amount[\s\S]*RETURNING cglt_balance INTO v_new_balance;[\s\S]*IF NOT FOUND THEN[\s\S]*INSUFFICIENT_CGLT/);
    });
    (0, node_test_1.it)('does not expose balance mutation RPCs to public roles', () => {
        for (const fn of ['wallet_debit_usdt', 'wallet_debit_cglt', 'wallet_credit_cglt', 'wallet_credit_cdf', 'wallet_adjust_cdf']) {
            strict_1.default.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(UUID, NUMERIC\\) FROM PUBLIC`));
        }
    });
    (0, node_test_1.it)('debits USDT through the guarded RPC before any on-chain send', () => {
        const route = source('src/routes/wallet/crypto-withdraw.ts');
        // crypto-withdraw uses begin_usdt_onchain_withdrawal, which atomically debits
        // USDT (with INSUFFICIENT_USDT guard) and creates the withdrawal record.
        const debit = route.indexOf("'begin_usdt_onchain_withdrawal'");
        const send = route.indexOf('await sendUsdt');
        strict_1.default.ok(debit >= 0);
        strict_1.default.ok(send > debit);
        strict_1.default.doesNotMatch(route, /\.gte\('usdt_balance', amount\)/);
    });
    (0, node_test_1.it)('uses atomic balance RPCs for admin adjustments and CGLT bridge or gaming paths', () => {
        const admin = source('src/routes/admin/wallet.ts');
        const gaming = source('src/routes/wallet/cglt-gaming.ts');
        const bridge = source('src/routes/wallet/wcglt-swap.ts');
        const incoming = source('src/routes/wallet/internal.ts');
        strict_1.default.match(admin, /\.rpc\('wallet_adjust_cdf'/);
        strict_1.default.match(gaming, /\.rpc\('wallet_debit_cglt'/);
        strict_1.default.match(gaming, /\.rpc\('wallet_credit_cglt'/);
        // wcglt-swap uses begin_wcglt_onchain_operation, which atomically debits
        // CGLT (with INSUFFICIENT_CGLT guard) and creates the operation state.
        strict_1.default.match(bridge, /\.rpc\(\s*'begin_wcglt_onchain_operation'/);
        // internal.ts uses process_bridge_incoming_credit, which atomically credits
        // CGLT and enforces tx_hash idempotency in one call.
        strict_1.default.match(incoming, /\.rpc\(\s*'process_bridge_incoming_credit'/);
        for (const route of [admin, gaming, bridge, incoming]) {
            strict_1.default.doesNotMatch(route, /update\(\{\s*(?:balance_cdf|cglt_balance|usdt_balance):/);
        }
    });
});
//# sourceMappingURL=atomic-wallet-balances.test.js.map