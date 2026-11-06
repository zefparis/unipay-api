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
 * H1 remediation tests — merchant payout guard.
 *
 * Verifies:
 *   - Migration adds grace_until + 'payout' ledger type + debit/recredit RPCs
 *   - initiate.ts checks KYC/grace before payout and debits the ledger
 *   - initiate.ts re-credits on immediate provider failure
 *   - balance.ts returns ledger balance (not global Unipesa float)
 *   - Settlement compatibility (payout type added, settlement unchanged)
 *   - No other merchant route exposes global provider balance
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
// __dirname = src/lib/__tests__, so ../../.. = project root
// (src/lib/__tests__ → src/lib → src → root)
const SRC = node_path_1.default.resolve(ROOT, 'src');
const INITIATE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/payment/initiate.ts'), 'utf-8');
const BALANCE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/merchant/balance.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260922000000_merchant_payout_guard.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('H1-migration — grace_until column', () => {
    (0, node_test_1.it)('adds grace_until timestamptz to merchants', () => {
        strict_1.default.match(MIGRATION, /ALTER TABLE public\.merchants\s+ADD COLUMN IF NOT EXISTS grace_until timestamptz/i);
    });
    (0, node_test_1.it)('has a comment explaining the grace policy', () => {
        strict_1.default.match(MIGRATION, /COMMENT ON COLUMN public\.merchants\.grace_until/i);
        strict_1.default.match(MIGRATION, /grace period/i);
    });
});
(0, node_test_1.describe)('H1-migration — payout ledger type', () => {
    (0, node_test_1.it)('drops the old CHECK constraint', () => {
        strict_1.default.match(MIGRATION, /ALTER TABLE public\.merchant_ledger_entries\s+DROP CONSTRAINT IF EXISTS merchant_ledger_entries_type_check/i);
    });
    (0, node_test_1.it)('adds a new CHECK constraint including payout', () => {
        strict_1.default.match(MIGRATION, /CHECK \(type IN \('credit', 'settlement', 'payout'\)\)/i);
    });
    (0, node_test_1.it)('preserves credit and settlement types', () => {
        strict_1.default.match(MIGRATION, /'credit'/);
        strict_1.default.match(MIGRATION, /'settlement'/);
    });
});
(0, node_test_1.describe)('H1-migration — debit_merchant_for_payout RPC', () => {
    (0, node_test_1.it)('creates the RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.debit_merchant_for_payout/i);
    });
    (0, node_test_1.it)('is SECURITY DEFINER', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?SECURITY DEFINER/);
    });
    (0, node_test_1.it)('locks the merchant row with FOR UPDATE', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?FOR UPDATE/);
    });
    (0, node_test_1.it)('checks kyc_status = approved', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?kyc_status != 'approved'/);
    });
    (0, node_test_1.it)('checks grace_until > now() as fallback', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?grace_until IS NULL OR v_merchant\.grace_until <= now\(\)/);
    });
    (0, node_test_1.it)('raises KYC_REQUIRED_FOR_PAYOUT when neither condition is met', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?KYC_REQUIRED_FOR_PAYOUT/);
    });
    (0, node_test_1.it)('computes balance per currency', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?currency = v_currency/);
    });
    (0, node_test_1.it)('validates amount <= balance', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?INSUFFICIENT_MERCHANT_BALANCE/);
    });
    (0, node_test_1.it)('inserts a payout ledger entry (debit)', () => {
        strict_1.default.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?'payout'[\s\S]*?merchant_ledger_entries/);
    });
});
(0, node_test_1.describe)('H1-migration — recredit_merchant_payout RPC', () => {
    (0, node_test_1.it)('creates the RPC', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.recredit_merchant_payout/i);
    });
    (0, node_test_1.it)('locks the transaction row with FOR UPDATE', () => {
        strict_1.default.match(MIGRATION, /recredit_merchant_payout[\s\S]*?FOR UPDATE/);
    });
    (0, node_test_1.it)('is idempotent — returns already_terminal if transaction is terminal', () => {
        strict_1.default.match(MIGRATION, /recredit_merchant_payout[\s\S]*?already_terminal/);
    });
    (0, node_test_1.it)('re-credits by inserting a credit ledger entry', () => {
        strict_1.default.match(MIGRATION, /recredit_merchant_payout[\s\S]*?'credit'[\s\S]*?merchant_ledger_entries/);
    });
    (0, node_test_1.it)('marks the transaction as failed', () => {
        strict_1.default.match(MIGRATION, /recredit_merchant_payout[\s\S]*?status = 'failed'/);
    });
});
(0, node_test_1.describe)('H1-migration — callback re-credit on failed payout', () => {
    (0, node_test_1.it)('extends process_wallet_provider_callback to re-credit merchant on failed payout', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.process_wallet_provider_callback/i);
        // The new re-credit block
        strict_1.default.match(MIGRATION, /p_new_status = 'failed' AND v_tx\.direction = 'payout'[\s\S]*?v_tx\.wallet_user_id IS NULL AND v_tx\.merchant_id IS NOT NULL/);
        strict_1.default.match(MIGRATION, /merchant_ledger_recredited/);
    });
    (0, node_test_1.it)('preserves existing collect credit logic', () => {
        strict_1.default.match(MIGRATION, /p_new_status = 'success' AND v_tx\.direction = 'collect'[\s\S]*?v_tx\.wallet_user_id IS NULL AND v_tx\.merchant_id IS NOT NULL/);
    });
    (0, node_test_1.it)('preserves settlement propagation', () => {
        strict_1.default.match(MIGRATION, /mark_settlement_success/);
        strict_1.default.match(MIGRATION, /mark_settlement_failed/);
    });
    (0, node_test_1.it)('preserves wallet user credit/refund logic', () => {
        strict_1.default.match(MIGRATION, /balance_cdf = balance_cdf \+ v_credit/);
        strict_1.default.match(MIGRATION, /balance_cdf = balance_cdf \+ v_refund/);
    });
});
(0, node_test_1.describe)('H1-migration — grants', () => {
    (0, node_test_1.it)('grants EXECUTE on debit_merchant_for_payout to service_role', () => {
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.debit_merchant_for_payout TO service_role/);
    });
    (0, node_test_1.it)('grants EXECUTE on recredit_merchant_payout to service_role', () => {
        strict_1.default.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.recredit_merchant_payout TO service_role/);
    });
});
(0, node_test_1.describe)('H1-migration — backfill (commented out for validation)', () => {
    (0, node_test_1.it)('contains a SELECT preview for qualifying merchants', () => {
        strict_1.default.match(MIGRATION, /kyc_status != 'approved'/);
        strict_1.default.match(MIGRATION, /t\.status = 'success'/);
        strict_1.default.match(MIGRATION, /direction IN \('collect', 'payout'\)/);
        strict_1.default.match(MIGRATION, /interval '30 days'/);
    });
    (0, node_test_1.it)('UPDATE backfill is commented out (requires manual validation)', () => {
        // The UPDATE should be commented out
        strict_1.default.match(MIGRATION, /-- UPDATE public\.merchants/);
        strict_1.default.match(MIGRATION, /-- SET grace_until = now\(\) \+ interval '7 days'/);
    });
    (0, node_test_1.it)('uses 7-day grace period', () => {
        strict_1.default.match(MIGRATION, /interval '7 days'/);
    });
});
// ── initiate.ts tests ────────────────────────────────────────
(0, node_test_1.describe)('H1-initiate — KYC/grace + ledger debit', () => {
    (0, node_test_1.it)('calls debit_merchant_for_payout RPC before provider call', () => {
        strict_1.default.match(INITIATE, /debit_merchant_for_payout/);
        strict_1.default.match(INITIATE, /p_merchant_id/);
        strict_1.default.match(INITIATE, /p_transaction_id/);
        strict_1.default.match(INITIATE, /p_amount/);
        strict_1.default.match(INITIATE, /p_currency/);
    });
    (0, node_test_1.it)('only debits for payouts (not collects)', () => {
        strict_1.default.match(INITIATE, /direction === 'payout'/);
    });
    (0, node_test_1.it)('skips debit in sandbox mode', () => {
        strict_1.default.match(INITIATE, /!isSandbox && direction === 'payout'/);
    });
    (0, node_test_1.it)('returns KYC_REQUIRED_FOR_PAYOUT (403) when KYC not approved and no grace', () => {
        strict_1.default.match(INITIATE, /KYC_REQUIRED_FOR_PAYOUT/);
        strict_1.default.match(INITIATE, /403/);
    });
    (0, node_test_1.it)('returns INSUFFICIENT_MERCHANT_BALANCE (402) when balance is too low', () => {
        strict_1.default.match(INITIATE, /INSUFFICIENT_MERCHANT_BALANCE/);
        strict_1.default.match(INITIATE, /402/);
    });
    (0, node_test_1.it)('calls recredit_merchant_payout on immediate provider failure', () => {
        strict_1.default.match(INITIATE, /recredit_merchant_payout/);
        // The re-credit call should be in the catch block
        const catchBlock = INITIATE.match(/catch \(err\) \{[\s\S]*?\}\s*\}/);
        strict_1.default.ok(catchBlock, 'must find catch block');
        strict_1.default.match(catchBlock[0], /recredit_merchant_payout/);
    });
    (0, node_test_1.it)('re-credit runs BEFORE the direct status update (RPC checks terminal status)', () => {
        // The RPC returns already_terminal if the transaction is already
        // 'failed', so the re-credit MUST run before the direct update.
        // Check the order in the full file (not just the catch block,
        // because the catch block has nested braces that break non-greedy regex).
        const recreditPos = INITIATE.indexOf('recredit_merchant_payout');
        const updatePos = INITIATE.indexOf("status: 'failed'");
        strict_1.default.ok(recreditPos > -1, 'must find recredit call');
        strict_1.default.ok(updatePos > -1, 'must find status update');
        strict_1.default.ok(recreditPos < updatePos, 'recredit_merchant_payout must run BEFORE the direct status: failed update');
    });
    (0, node_test_1.it)('re-credit is only for payouts', () => {
        const recreditSection = INITIATE.match(/recredit_merchant_payout[\s\S]*?p_reason/);
        strict_1.default.ok(recreditSection);
        // Check that the condition guards on direction === 'payout'
        const recreditBlock = INITIATE.match(/if \(!isSandbox && direction === 'payout'\) \{[\s\S]*?recredit_merchant_payout[\s\S]*?\}/);
        strict_1.default.ok(recreditBlock, 're-credit must be guarded by direction === payout');
    });
});
// ── balance.ts tests ──────────────────────────────────────────
(0, node_test_1.describe)('H1-balance — merchant ledger balance (not global float)', () => {
    (0, node_test_1.it)('does NOT import getBalance from avada', () => {
        strict_1.default.doesNotMatch(BALANCE, /import\s*\{[^}]*getBalance[^}]*\}\s*from\s*['"].*avada['"]/);
    });
    (0, node_test_1.it)('does NOT call getBalance() as a function (outside comments)', () => {
        // Strip comment lines before checking for actual calls.
        // The only mention of getBalance should be in comments explaining
        // what was removed — there must be no actual call expression.
        const stripped = BALANCE
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        strict_1.default.doesNotMatch(stripped, /getBalance\(\)/);
    });
    (0, node_test_1.it)('queries merchant_ledger_entries', () => {
        strict_1.default.match(BALANCE, /merchant_ledger_entries/);
    });
    (0, node_test_1.it)('filters by merchant_id from auth payload', () => {
        strict_1.default.match(BALANCE, /auth\.payload\.merchant_id/);
        strict_1.default.match(BALANCE, /\.eq\('merchant_id', merchantId\)/);
    });
    (0, node_test_1.it)('filters by currency', () => {
        strict_1.default.match(BALANCE, /\.eq\('currency', currency\)/);
    });
    (0, node_test_1.it)('computes balance as credits minus debits', () => {
        strict_1.default.match(BALANCE, /row\.type === 'credit'/);
        strict_1.default.match(BALANCE, /sum \+ Number\(row\.amount\)/);
        strict_1.default.match(BALANCE, /sum - Number\(row\.amount\)/);
    });
    (0, node_test_1.it)('returns the computed balance (not avadaBalance)', () => {
        strict_1.default.match(BALANCE, /balance,/);
        strict_1.default.match(BALANCE, /currency,/);
        strict_1.default.match(BALANCE, /mode:/);
    });
    (0, node_test_1.it)('handles ledger query errors explicitly', () => {
        strict_1.default.match(BALANCE, /ledgerError/);
        strict_1.default.match(BALANCE, /Failed to compute merchant balance/);
    });
    (0, node_test_1.it)('supports currency query parameter', () => {
        strict_1.default.match(BALANCE, /currency.*query/);
        strict_1.default.match(BALANCE, /CDF.*USD.*USDT/);
    });
});
// ── Settlement compatibility tests ────────────────────────────
(0, node_test_1.describe)('H1-settlement — compatibility', () => {
    (0, node_test_1.it)('settlement RPCs still use settlement type (not payout)', () => {
        const settlementRpc = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260907020200_settlement_rpcs.sql'), 'utf-8');
        strict_1.default.match(settlementRpc, /'settlement'/);
        // The settlement RPC should NOT use 'payout'
        strict_1.default.doesNotMatch(settlementRpc, /'payout'/);
    });
    (0, node_test_1.it)('balance formula treats all non-credit as debits (payout included)', () => {
        // The migration's debit RPC uses the same formula as settlement RPCs
        strict_1.default.match(MIGRATION, /CASE WHEN type = 'credit' THEN amount ELSE -amount END/);
    });
    (0, node_test_1.it)('settlement re-credit uses credit type (not payout)', () => {
        const settlementRpc = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260907020200_settlement_rpcs.sql'), 'utf-8');
        // reject_settlement and mark_settlement_failed re-credit with 'credit'
        strict_1.default.match(settlementRpc, /'credit'/);
    });
});
// ── No other route exposes global float ───────────────────────
(0, node_test_1.describe)('H1-isolation — no other merchant route uses getBalance', () => {
    (0, node_test_1.it)('merchant/balance.ts does not call getBalance() as a function', () => {
        // The only mention should be in comments. No actual call expression.
        strict_1.default.doesNotMatch(BALANCE, /=\s*getBalance\(\)/);
        strict_1.default.doesNotMatch(BALANCE, /await\s+getBalance\(\)/);
    });
    (0, node_test_1.it)('admin/wallet.ts avada-balance route returns null (not exposed)', () => {
        const adminWallet = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/admin/wallet.ts'), 'utf-8');
        // The admin route should return { balance: null } not call getBalance
        strict_1.default.match(adminWallet, /balance: null/);
    });
});
//# sourceMappingURL=h1-merchant-payout-guard.test.js.map