/**
 * Tests: multi-currency merchant support.
 *
 * B2: initiate.ts accepts only CDF/USD/USDT with operator-specific rules
 * B6: settlement balance returns balances[] per currency
 * B7: settlement request accepts currency param
 * B8: revenue groups by currency
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_DIR = path.resolve(__dirname, '../../routes');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(ROUTES_DIR, rel), 'utf-8');
}

function readMigration(name: string): string {
  return fs.readFileSync(path.resolve(MIGRATIONS_DIR, name), 'utf-8');
}

// ─── B2: initiate.ts currency validation ──────────────────────

describe('B2 — initiate.ts currency validation', () => {
  const SRC = readSrc('payment/initiate.ts');

  it('currency schema is an enum, not a free string', () => {
    assert.match(
      SRC,
      /currency:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:\s*\[/,
      'currency must be an enum, not minLength/maxLength',
    );
  });

  it('enum includes CDF, USD, and USDT', () => {
    assert.match(SRC, /enum:\s*\['CDF',\s*'USD',\s*'USDT'\]/, 'enum must include CDF, USD, USDT');
  });

  it('rejects USDT currency with non-usdt operator', () => {
    assert.match(
      SRC,
      /operator !== 'usdt' && currency === 'USDT'/,
      'must reject USDT currency with mobile money operators',
    );
  });

  it('rejects non-USDT currency with usdt operator', () => {
    assert.match(
      SRC,
      /operator === 'usdt' && currency !== 'USDT'/,
      'must reject non-USDT currency with usdt operator',
    );
  });
});

// ─── B1: Migration — ledger currency column ───────────────────

describe('B1 — migration adds currency to merchant_ledger_entries', () => {
  const MIG = readMigration('20260908000000_merchant_multi_currency.sql');

  it('adds currency column to merchant_ledger_entries', () => {
    assert.match(
      MIG,
      /ALTER TABLE public\.merchant_ledger_entries\s+ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF'/,
      'must add currency column with CDF default',
    );
  });

  it('adds CHECK constraint on merchant_ledger_entries.currency', () => {
    assert.match(
      MIG,
      /merchant_ledger_currency_check/,
      'must add CHECK constraint for currency',
    );
    assert.match(
      MIG,
      /CHECK \(currency IN \('CDF', 'USD', 'USDT'\)\)/,
      'CHECK must allow CDF, USD, USDT',
    );
  });

  it('adds currency column to merchant_settlement_requests', () => {
    assert.match(
      MIG,
      /ALTER TABLE public\.merchant_settlement_requests\s+ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF'/,
      'must add currency column to settlement requests',
    );
  });

  it('adds CHECK constraint on transactions.currency', () => {
    assert.match(
      MIG,
      /transactions_currency_check/,
      'must add CHECK constraint on transactions.currency',
    );
  });
});

// ─── B3: Callback RPC propagates currency ─────────────────────

describe('B3 — callback RPC propagates currency to ledger', () => {
  const MIG = readMigration('20260908000100_callback_ledger_currency.sql');

  it('ledger INSERT includes currency column', () => {
    assert.match(
      MIG,
      /INSERT INTO public\.merchant_ledger_entries \(\s*merchant_id, transaction_id, type, amount, balance_after, currency\s*\)/,
      'ledger INSERT must include currency column',
    );
  });

  it('balance computation filters by currency', () => {
    assert.match(
      MIG,
      /WHERE merchant_id = v_tx\.merchant_id\s+AND currency = upper\(v_tx\.currency\)/,
      'balance computation must filter by currency',
    );
  });
});

// ─── B4: Settlement RPCs accept p_currency ────────────────────

describe('B4 — settlement RPCs accept p_currency', () => {
  const MIG = readMigration('20260908000000_merchant_multi_currency.sql');

  it('process_merchant_settlement has p_currency parameter', () => {
    assert.match(
      MIG,
      /p_currency TEXT DEFAULT 'CDF'/,
      'process_merchant_settlement must accept p_currency',
    );
  });

  it('balance computation filters by currency in process_merchant_settlement', () => {
    assert.match(
      MIG,
      /WHERE merchant_id = p_merchant_id\s+AND currency = v_currency/,
      'settlement balance must filter by currency',
    );
  });

  it('reject_settlement re-credits in the same currency', () => {
    assert.match(
      MIG,
      /WHERE merchant_id = v_req\.merchant_id\s+AND currency = v_req\.currency/,
      'reject_settlement must filter by currency',
    );
  });

  it('mark_settlement_failed re-credits in the same currency', () => {
    // Check the mark_settlement_failed function in the migration
    const failedFnMatch = MIG.match(/CREATE OR REPLACE FUNCTION public\.mark_settlement_failed[\s\S]*?END;\s*\$\$/);
    assert.ok(failedFnMatch, 'must find mark_settlement_failed function');
    assert.match(
      failedFnMatch[0],
      /currency = v_req\.currency/,
      'mark_settlement_failed must filter by currency',
    );
  });
});

// ─── B6: Settlement balance returns per-currency balances ─────

describe('B6 — settlement balance returns balances[] per currency', () => {
  const SRC = readSrc('merchant/settlement.ts');

  it('selects currency from ledger entries', () => {
    assert.match(
      SRC,
      /select\('type, amount, currency'\)/,
      'must select currency from ledger entries',
    );
  });

  it('returns balances array in response', () => {
    assert.match(
      SRC,
      /balances,/,
      'must return balances array',
    );
  });

  it('each balance entry has currency, balance, total_credits, total_settlements', () => {
    assert.match(
      SRC,
      /currency: cur,\s*balance:/,
      'balance entries must have currency and balance',
    );
  });

  it('always includes CDF and USD even with no ledger entries', () => {
    // The ALWAYS_VISIBLE_CURRENCIES array guarantees CDF + USD are present
    // even when no ledger rows exist for that currency.
    assert.match(
      SRC,
      /ALWAYS_VISIBLE_CURRENCIES = \['CDF', 'USD'\]/,
      'must declare CDF and USD as always-visible currencies',
    );
    assert.match(
      SRC,
      /for \(const cur of ALWAYS_VISIBLE_CURRENCIES\)/,
      'must iterate over ALWAYS_VISIBLE_CURRENCIES to seed zero balances',
    );
    assert.match(
      SRC,
      /if \(!byCurrency\[cur\]\)/,
      'must seed zero-balance entry if currency is missing from ledger',
    );
  });

  it('USDT is NOT always visible (only appears if ledger entries exist)', () => {
    // USDT should not be in the always-visible list
    const alwaysVisibleMatch = SRC.match(/ALWAYS_VISIBLE_CURRENCIES = \[([^\]]+)\]/);
    assert.ok(alwaysVisibleMatch, 'ALWAYS_VISIBLE_CURRENCIES array must exist');
    assert.doesNotMatch(
      alwaysVisibleMatch[1],
      /USDT/,
      'USDT must not be in ALWAYS_VISIBLE_CURRENCIES (crypto is opt-in only)',
    );
  });

  it('balances are ordered CDF first, USD second, then USDT', () => {
    assert.match(
      SRC,
      /currencyOrder = \['CDF', 'USD', 'USDT'\]/,
      'must define currency order with CDF first, USD second, USDT third',
    );
  });
});

// ─── B7: Settlement request accepts currency ──────────────────

describe('B7 — settlement request accepts currency param', () => {
  const SRC = readSrc('merchant/settlement.ts');

  it('body schema includes currency enum', () => {
    assert.match(
      SRC,
      /currency:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:\s*\['CDF',\s*'USD'\]/,
      'request body must accept currency CDF or USD',
    );
  });

  it('passes p_currency to the RPC', () => {
    assert.match(
      SRC,
      /p_currency: settlementCurrency/,
      'must pass p_currency to process_merchant_settlement RPC',
    );
  });

  it('payout uses settlementCurrency, not hardcoded CDF', () => {
    assert.match(
      SRC,
      /settlementCurrency,\s*\);/,
      'initiatePayout must use settlementCurrency',
    );
    assert.doesNotMatch(
      SRC,
      /'CDF',\s*\);/,
      'must not hardcode CDF in initiatePayout call',
    );
  });

  it('history query selects currency', () => {
    assert.match(
      SRC,
      /select\('id, amount, currency, phone/,
      'history query must select currency',
    );
  });
});

// ─── B8: Revenue groups by currency ───────────────────────────

describe('B8 — revenue groups by currency', () => {
  const SRC = readSrc('admin/merchants.ts');

  it('revenue query selects currency from transactions', () => {
    // The revenue query selects merchant_id, amount, fee, net_amount, currency
    assert.match(
      SRC,
      /select\('merchant_id, amount, fee, net_amount, currency'\)/,
      'revenue query must select currency',
    );
  });

  it('builds by_currency breakdown per merchant', () => {
    assert.match(
      SRC,
      /by_currency:/,
      'must include by_currency in merchant response',
    );
  });

  it('returns totals_by_currency', () => {
    assert.match(
      SRC,
      /totals_by_currency/,
      'must return totals_by_currency in response',
    );
  });
});

// ─── B9: Export CSV includes currency column ──────────────────

describe('B9 — export CSV includes currency column', () => {
  const SRC = readSrc('admin/merchants.ts');

  it('export query selects currency', () => {
    // Both revenue and export queries select currency — verify at least 2 occurrences
    const matches = SRC.match(/select\('merchant_id, amount, fee, net_amount, currency'\)/g);
    assert.ok(matches && matches.length >= 2, 'export query must select currency (at least 2 currency selects expected)');
  });

  it('CSV headers include currency', () => {
    assert.match(
      SRC,
      /headers = \[.*?currency.*?\]/,
      'CSV headers must include currency',
    );
  });

  it('aggregates per merchant + currency (not just per merchant)', () => {
    assert.match(
      SRC,
      /perMerchantCurrency/,
      'export must aggregate per merchant + currency',
    );
  });
});
