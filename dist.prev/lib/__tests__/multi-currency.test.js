"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tests: multi-currency merchant support.
 *
 * B2: initiate.ts accepts only CDF/USD/USDT with operator-specific rules
 * B6: settlement balance returns balances[] per currency
 * B7: settlement request accepts currency param
 * B8: revenue groups by currency
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const ROUTES_DIR = node_path_1.default.resolve(__dirname, '../../routes');
const MIGRATIONS_DIR = node_path_1.default.resolve(__dirname, '../../../supabase/migrations');
function readSrc(rel) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(ROUTES_DIR, rel), 'utf-8');
}
function readMigration(name) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(MIGRATIONS_DIR, name), 'utf-8');
}
// ─── B2: initiate.ts currency validation ──────────────────────
(0, node_test_1.describe)('B2 — initiate.ts currency validation', () => {
    const SRC = readSrc('payment/initiate.ts');
    (0, node_test_1.it)('currency schema is an enum, not a free string', () => {
        strict_1.default.match(SRC, /currency:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:\s*\[/, 'currency must be an enum, not minLength/maxLength');
    });
    (0, node_test_1.it)('enum includes CDF, USD, and USDT', () => {
        strict_1.default.match(SRC, /enum:\s*\['CDF',\s*'USD',\s*'USDT'\]/, 'enum must include CDF, USD, USDT');
    });
    (0, node_test_1.it)('rejects USDT currency with non-usdt operator', () => {
        strict_1.default.match(SRC, /operator !== 'usdt' && currency === 'USDT'/, 'must reject USDT currency with mobile money operators');
    });
    (0, node_test_1.it)('rejects non-USDT currency with usdt operator', () => {
        strict_1.default.match(SRC, /operator === 'usdt' && currency !== 'USDT'/, 'must reject non-USDT currency with usdt operator');
    });
});
// ─── B1: Migration — ledger currency column ───────────────────
(0, node_test_1.describe)('B1 — migration adds currency to merchant_ledger_entries', () => {
    const MIG = readMigration('20260908000000_merchant_multi_currency.sql');
    (0, node_test_1.it)('adds currency column to merchant_ledger_entries', () => {
        strict_1.default.match(MIG, /ALTER TABLE public\.merchant_ledger_entries\s+ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF'/, 'must add currency column with CDF default');
    });
    (0, node_test_1.it)('adds CHECK constraint on merchant_ledger_entries.currency', () => {
        strict_1.default.match(MIG, /merchant_ledger_currency_check/, 'must add CHECK constraint for currency');
        strict_1.default.match(MIG, /CHECK \(currency IN \('CDF', 'USD', 'USDT'\)\)/, 'CHECK must allow CDF, USD, USDT');
    });
    (0, node_test_1.it)('adds currency column to merchant_settlement_requests', () => {
        strict_1.default.match(MIG, /ALTER TABLE public\.merchant_settlement_requests\s+ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF'/, 'must add currency column to settlement requests');
    });
    (0, node_test_1.it)('adds CHECK constraint on transactions.currency', () => {
        strict_1.default.match(MIG, /transactions_currency_check/, 'must add CHECK constraint on transactions.currency');
    });
});
// ─── B3: Callback RPC propagates currency ─────────────────────
(0, node_test_1.describe)('B3 — callback RPC propagates currency to ledger', () => {
    const MIG = readMigration('20260908000100_callback_ledger_currency.sql');
    (0, node_test_1.it)('ledger INSERT includes currency column', () => {
        strict_1.default.match(MIG, /INSERT INTO public\.merchant_ledger_entries \(\s*merchant_id, transaction_id, type, amount, balance_after, currency\s*\)/, 'ledger INSERT must include currency column');
    });
    (0, node_test_1.it)('balance computation filters by currency', () => {
        strict_1.default.match(MIG, /WHERE merchant_id = v_tx\.merchant_id\s+AND currency = upper\(v_tx\.currency\)/, 'balance computation must filter by currency');
    });
});
// ─── B4: Settlement RPCs accept p_currency ────────────────────
(0, node_test_1.describe)('B4 — settlement RPCs accept p_currency', () => {
    const MIG = readMigration('20260908000000_merchant_multi_currency.sql');
    (0, node_test_1.it)('process_merchant_settlement has p_currency parameter', () => {
        strict_1.default.match(MIG, /p_currency TEXT DEFAULT 'CDF'/, 'process_merchant_settlement must accept p_currency');
    });
    (0, node_test_1.it)('balance computation filters by currency in process_merchant_settlement', () => {
        strict_1.default.match(MIG, /WHERE merchant_id = p_merchant_id\s+AND currency = v_currency/, 'settlement balance must filter by currency');
    });
    (0, node_test_1.it)('reject_settlement re-credits in the same currency', () => {
        strict_1.default.match(MIG, /WHERE merchant_id = v_req\.merchant_id\s+AND currency = v_req\.currency/, 'reject_settlement must filter by currency');
    });
    (0, node_test_1.it)('mark_settlement_failed re-credits in the same currency', () => {
        // Check the mark_settlement_failed function in the migration
        const failedFnMatch = MIG.match(/CREATE OR REPLACE FUNCTION public\.mark_settlement_failed[\s\S]*?END;\s*\$\$/);
        strict_1.default.ok(failedFnMatch, 'must find mark_settlement_failed function');
        strict_1.default.match(failedFnMatch[0], /currency = v_req\.currency/, 'mark_settlement_failed must filter by currency');
    });
});
// ─── B6: Settlement balance returns per-currency balances ─────
(0, node_test_1.describe)('B6 — settlement balance returns balances[] per currency', () => {
    const SRC = readSrc('merchant/settlement.ts');
    (0, node_test_1.it)('selects currency from ledger entries', () => {
        strict_1.default.match(SRC, /select\('type, amount, currency'\)/, 'must select currency from ledger entries');
    });
    (0, node_test_1.it)('returns balances array in response', () => {
        strict_1.default.match(SRC, /balances,/, 'must return balances array');
    });
    (0, node_test_1.it)('each balance entry has currency, balance, total_credits, total_settlements', () => {
        strict_1.default.match(SRC, /currency: cur,\s*balance:/, 'balance entries must have currency and balance');
    });
    (0, node_test_1.it)('always includes CDF and USD even with no ledger entries', () => {
        // The ALWAYS_VISIBLE_CURRENCIES array guarantees CDF + USD are present
        // even when no ledger rows exist for that currency.
        strict_1.default.match(SRC, /ALWAYS_VISIBLE_CURRENCIES = \['CDF', 'USD'\]/, 'must declare CDF and USD as always-visible currencies');
        strict_1.default.match(SRC, /for \(const cur of ALWAYS_VISIBLE_CURRENCIES\)/, 'must iterate over ALWAYS_VISIBLE_CURRENCIES to seed zero balances');
        strict_1.default.match(SRC, /if \(!byCurrency\[cur\]\)/, 'must seed zero-balance entry if currency is missing from ledger');
    });
    (0, node_test_1.it)('USDT is NOT always visible (only appears if ledger entries exist)', () => {
        // USDT should not be in the always-visible list
        const alwaysVisibleMatch = SRC.match(/ALWAYS_VISIBLE_CURRENCIES = \[([^\]]+)\]/);
        strict_1.default.ok(alwaysVisibleMatch, 'ALWAYS_VISIBLE_CURRENCIES array must exist');
        strict_1.default.doesNotMatch(alwaysVisibleMatch[1], /USDT/, 'USDT must not be in ALWAYS_VISIBLE_CURRENCIES (crypto is opt-in only)');
    });
    (0, node_test_1.it)('balances are ordered CDF first, USD second, then USDT', () => {
        strict_1.default.match(SRC, /currencyOrder = \['CDF', 'USD', 'USDT'\]/, 'must define currency order with CDF first, USD second, USDT third');
    });
});
// ─── B7: Settlement request accepts currency ──────────────────
(0, node_test_1.describe)('B7 — settlement request accepts currency param', () => {
    const SRC = readSrc('merchant/settlement.ts');
    (0, node_test_1.it)('body schema includes currency enum', () => {
        strict_1.default.match(SRC, /currency:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:\s*\['CDF',\s*'USD'\]/, 'request body must accept currency CDF or USD');
    });
    (0, node_test_1.it)('passes p_currency to the RPC', () => {
        strict_1.default.match(SRC, /p_currency: settlementCurrency/, 'must pass p_currency to process_merchant_settlement RPC');
    });
    (0, node_test_1.it)('payout uses settlementCurrency, not hardcoded CDF', () => {
        strict_1.default.match(SRC, /settlementCurrency,\s*\);/, 'initiatePayout must use settlementCurrency');
        strict_1.default.doesNotMatch(SRC, /'CDF',\s*\);/, 'must not hardcode CDF in initiatePayout call');
    });
    (0, node_test_1.it)('history query selects currency', () => {
        strict_1.default.match(SRC, /select\('id, amount, currency, phone/, 'history query must select currency');
    });
});
// ─── B8: Revenue groups by currency ───────────────────────────
(0, node_test_1.describe)('B8 — revenue groups by currency', () => {
    const SRC = readSrc('admin/merchants.ts');
    (0, node_test_1.it)('revenue query selects currency from transactions', () => {
        // The revenue query selects merchant_id, amount, fee, net_amount, currency
        strict_1.default.match(SRC, /select\('merchant_id, amount, fee, net_amount, currency'\)/, 'revenue query must select currency');
    });
    (0, node_test_1.it)('builds by_currency breakdown per merchant', () => {
        strict_1.default.match(SRC, /by_currency:/, 'must include by_currency in merchant response');
    });
    (0, node_test_1.it)('returns totals_by_currency', () => {
        strict_1.default.match(SRC, /totals_by_currency/, 'must return totals_by_currency in response');
    });
});
// ─── B9: Export CSV includes currency column ──────────────────
(0, node_test_1.describe)('B9 — export CSV includes currency column', () => {
    const SRC = readSrc('admin/merchants.ts');
    (0, node_test_1.it)('export query selects currency', () => {
        // Both revenue and export queries select currency — verify at least 2 occurrences
        const matches = SRC.match(/select\('merchant_id, amount, fee, net_amount, currency'\)/g);
        strict_1.default.ok(matches && matches.length >= 2, 'export query must select currency (at least 2 currency selects expected)');
    });
    (0, node_test_1.it)('CSV headers include currency', () => {
        strict_1.default.match(SRC, /headers = \[.*?currency.*?\]/, 'CSV headers must include currency');
    });
    (0, node_test_1.it)('aggregates per merchant + currency (not just per merchant)', () => {
        strict_1.default.match(SRC, /perMerchantCurrency/, 'export must aggregate per merchant + currency');
    });
});
//# sourceMappingURL=multi-currency.test.js.map