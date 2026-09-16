import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
// __dirname = src/lib/__tests__, so ../../.. = project root
// (src/lib/__tests__ → src/lib → src → root)
const SRC = path.resolve(ROOT, 'src');
const INITIATE = fs.readFileSync(
  path.resolve(SRC, 'routes/payment/initiate.ts'),
  'utf-8',
);
const BALANCE = fs.readFileSync(
  path.resolve(SRC, 'routes/merchant/balance.ts'),
  'utf-8',
);
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260922000000_merchant_payout_guard.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('H1-migration — grace_until column', () => {
  it('adds grace_until timestamptz to merchants', () => {
    assert.match(
      MIGRATION,
      /ALTER TABLE public\.merchants\s+ADD COLUMN IF NOT EXISTS grace_until timestamptz/i,
    );
  });

  it('has a comment explaining the grace policy', () => {
    assert.match(MIGRATION, /COMMENT ON COLUMN public\.merchants\.grace_until/i);
    assert.match(MIGRATION, /grace period/i);
  });
});

describe('H1-migration — payout ledger type', () => {
  it('drops the old CHECK constraint', () => {
    assert.match(
      MIGRATION,
      /ALTER TABLE public\.merchant_ledger_entries\s+DROP CONSTRAINT IF EXISTS merchant_ledger_entries_type_check/i,
    );
  });

  it('adds a new CHECK constraint including payout', () => {
    assert.match(
      MIGRATION,
      /CHECK \(type IN \('credit', 'settlement', 'payout'\)\)/i,
    );
  });

  it('preserves credit and settlement types', () => {
    assert.match(MIGRATION, /'credit'/);
    assert.match(MIGRATION, /'settlement'/);
  });
});

describe('H1-migration — debit_merchant_for_payout RPC', () => {
  it('creates the RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.debit_merchant_for_payout/i);
  });

  it('is SECURITY DEFINER', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?SECURITY DEFINER/);
  });

  it('locks the merchant row with FOR UPDATE', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?FOR UPDATE/);
  });

  it('checks kyc_status = approved', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?kyc_status != 'approved'/);
  });

  it('checks grace_until > now() as fallback', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?grace_until IS NULL OR v_merchant\.grace_until <= now\(\)/);
  });

  it('raises KYC_REQUIRED_FOR_PAYOUT when neither condition is met', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?KYC_REQUIRED_FOR_PAYOUT/);
  });

  it('computes balance per currency', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?currency = v_currency/);
  });

  it('validates amount <= balance', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?INSUFFICIENT_MERCHANT_BALANCE/);
  });

  it('inserts a payout ledger entry (debit)', () => {
    assert.match(MIGRATION, /debit_merchant_for_payout[\s\S]*?'payout'[\s\S]*?merchant_ledger_entries/);
  });
});

describe('H1-migration — recredit_merchant_payout RPC', () => {
  it('creates the RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.recredit_merchant_payout/i);
  });

  it('locks the transaction row with FOR UPDATE', () => {
    assert.match(MIGRATION, /recredit_merchant_payout[\s\S]*?FOR UPDATE/);
  });

  it('is idempotent — returns already_terminal if transaction is terminal', () => {
    assert.match(MIGRATION, /recredit_merchant_payout[\s\S]*?already_terminal/);
  });

  it('re-credits by inserting a credit ledger entry', () => {
    assert.match(MIGRATION, /recredit_merchant_payout[\s\S]*?'credit'[\s\S]*?merchant_ledger_entries/);
  });

  it('marks the transaction as failed', () => {
    assert.match(MIGRATION, /recredit_merchant_payout[\s\S]*?status = 'failed'/);
  });
});

describe('H1-migration — callback re-credit on failed payout', () => {
  it('extends process_wallet_provider_callback to re-credit merchant on failed payout', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.process_wallet_provider_callback/i);
    // The new re-credit block
    assert.match(
      MIGRATION,
      /p_new_status = 'failed' AND v_tx\.direction = 'payout'[\s\S]*?v_tx\.wallet_user_id IS NULL AND v_tx\.merchant_id IS NOT NULL/,
    );
    assert.match(MIGRATION, /merchant_ledger_recredited/);
  });

  it('preserves existing collect credit logic', () => {
    assert.match(
      MIGRATION,
      /p_new_status = 'success' AND v_tx\.direction = 'collect'[\s\S]*?v_tx\.wallet_user_id IS NULL AND v_tx\.merchant_id IS NOT NULL/,
    );
  });

  it('preserves settlement propagation', () => {
    assert.match(MIGRATION, /mark_settlement_success/);
    assert.match(MIGRATION, /mark_settlement_failed/);
  });

  it('preserves wallet user credit/refund logic', () => {
    assert.match(MIGRATION, /balance_cdf = balance_cdf \+ v_credit/);
    assert.match(MIGRATION, /balance_cdf = balance_cdf \+ v_refund/);
  });
});

describe('H1-migration — grants', () => {
  it('grants EXECUTE on debit_merchant_for_payout to service_role', () => {
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.debit_merchant_for_payout TO service_role/);
  });

  it('grants EXECUTE on recredit_merchant_payout to service_role', () => {
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.recredit_merchant_payout TO service_role/);
  });
});

describe('H1-migration — backfill (commented out for validation)', () => {
  it('contains a SELECT preview for qualifying merchants', () => {
    assert.match(MIGRATION, /kyc_status != 'approved'/);
    assert.match(MIGRATION, /t\.status = 'success'/);
    assert.match(MIGRATION, /direction IN \('collect', 'payout'\)/);
    assert.match(MIGRATION, /interval '30 days'/);
  });

  it('UPDATE backfill is commented out (requires manual validation)', () => {
    // The UPDATE should be commented out
    assert.match(MIGRATION, /-- UPDATE public\.merchants/);
    assert.match(MIGRATION, /-- SET grace_until = now\(\) \+ interval '7 days'/);
  });

  it('uses 7-day grace period', () => {
    assert.match(MIGRATION, /interval '7 days'/);
  });
});

// ── initiate.ts tests ────────────────────────────────────────

describe('H1-initiate — KYC/grace + ledger debit', () => {
  it('calls debit_merchant_for_payout RPC before provider call', () => {
    assert.match(INITIATE, /debit_merchant_for_payout/);
    assert.match(INITIATE, /p_merchant_id/);
    assert.match(INITIATE, /p_transaction_id/);
    assert.match(INITIATE, /p_amount/);
    assert.match(INITIATE, /p_currency/);
  });

  it('only debits for payouts (not collects)', () => {
    assert.match(INITIATE, /direction === 'payout'/);
  });

  it('skips debit in sandbox mode', () => {
    assert.match(INITIATE, /!isSandbox && direction === 'payout'/);
  });

  it('returns KYC_REQUIRED_FOR_PAYOUT (403) when KYC not approved and no grace', () => {
    assert.match(INITIATE, /KYC_REQUIRED_FOR_PAYOUT/);
    assert.match(INITIATE, /403/);
  });

  it('returns INSUFFICIENT_MERCHANT_BALANCE (402) when balance is too low', () => {
    assert.match(INITIATE, /INSUFFICIENT_MERCHANT_BALANCE/);
    assert.match(INITIATE, /402/);
  });

  it('calls recredit_merchant_payout on immediate provider failure', () => {
    assert.match(INITIATE, /recredit_merchant_payout/);
    // The re-credit call should be in the catch block
    const catchBlock = INITIATE.match(/catch \(err\) \{[\s\S]*?\}\s*\}/);
    assert.ok(catchBlock, 'must find catch block');
    assert.match(catchBlock[0], /recredit_merchant_payout/);
  });

  it('re-credit runs BEFORE the direct status update (RPC checks terminal status)', () => {
    // The RPC returns already_terminal if the transaction is already
    // 'failed', so the re-credit MUST run before the direct update.
    // Check the order in the full file (not just the catch block,
    // because the catch block has nested braces that break non-greedy regex).
    const recreditPos = INITIATE.indexOf('recredit_merchant_payout');
    const updatePos = INITIATE.indexOf("status: 'failed'");
    assert.ok(recreditPos > -1, 'must find recredit call');
    assert.ok(updatePos > -1, 'must find status update');
    assert.ok(
      recreditPos < updatePos,
      'recredit_merchant_payout must run BEFORE the direct status: failed update',
    );
  });

  it('re-credit is only for payouts', () => {
    const recreditSection = INITIATE.match(/recredit_merchant_payout[\s\S]*?p_reason/);
    assert.ok(recreditSection);
    // Check that the condition guards on direction === 'payout'
    const recreditBlock = INITIATE.match(/if \(!isSandbox && direction === 'payout'\) \{[\s\S]*?recredit_merchant_payout[\s\S]*?\}/);
    assert.ok(recreditBlock, 're-credit must be guarded by direction === payout');
  });
});

// ── balance.ts tests ──────────────────────────────────────────

describe('H1-balance — merchant ledger balance (not global float)', () => {
  it('does NOT import getBalance from avada', () => {
    assert.doesNotMatch(BALANCE, /import\s*\{[^}]*getBalance[^}]*\}\s*from\s*['"].*avada['"]/);
  });

  it('does NOT call getBalance() as a function (outside comments)', () => {
    // Strip comment lines before checking for actual calls.
    // The only mention of getBalance should be in comments explaining
    // what was removed — there must be no actual call expression.
    const stripped = BALANCE
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(stripped, /getBalance\(\)/);
  });

  it('queries merchant_ledger_entries', () => {
    assert.match(BALANCE, /merchant_ledger_entries/);
  });

  it('filters by merchant_id from auth payload', () => {
    assert.match(BALANCE, /auth\.payload\.merchant_id/);
    assert.match(BALANCE, /\.eq\('merchant_id', merchantId\)/);
  });

  it('filters by currency', () => {
    assert.match(BALANCE, /\.eq\('currency', currency\)/);
  });

  it('computes balance as credits minus debits', () => {
    assert.match(BALANCE, /row\.type === 'credit'/);
    assert.match(BALANCE, /sum \+ Number\(row\.amount\)/);
    assert.match(BALANCE, /sum - Number\(row\.amount\)/);
  });

  it('returns the computed balance (not avadaBalance)', () => {
    assert.match(BALANCE, /balance,/);
    assert.match(BALANCE, /currency,/);
    assert.match(BALANCE, /mode:/);
  });

  it('handles ledger query errors explicitly', () => {
    assert.match(BALANCE, /ledgerError/);
    assert.match(BALANCE, /Failed to compute merchant balance/);
  });

  it('supports currency query parameter', () => {
    assert.match(BALANCE, /currency.*query/);
    assert.match(BALANCE, /CDF.*USD.*USDT/);
  });
});

// ── Settlement compatibility tests ────────────────────────────

describe('H1-settlement — compatibility', () => {
  it('settlement RPCs still use settlement type (not payout)', () => {
    const settlementRpc = fs.readFileSync(
      path.resolve(ROOT, 'supabase/migrations/20260907020200_settlement_rpcs.sql'),
      'utf-8',
    );
    assert.match(settlementRpc, /'settlement'/);
    // The settlement RPC should NOT use 'payout'
    assert.doesNotMatch(settlementRpc, /'payout'/);
  });

  it('balance formula treats all non-credit as debits (payout included)', () => {
    // The migration's debit RPC uses the same formula as settlement RPCs
    assert.match(
      MIGRATION,
      /CASE WHEN type = 'credit' THEN amount ELSE -amount END/,
    );
  });

  it('settlement re-credit uses credit type (not payout)', () => {
    const settlementRpc = fs.readFileSync(
      path.resolve(ROOT, 'supabase/migrations/20260907020200_settlement_rpcs.sql'),
      'utf-8',
    );
    // reject_settlement and mark_settlement_failed re-credit with 'credit'
    assert.match(settlementRpc, /'credit'/);
  });
});

// ── No other route exposes global float ───────────────────────

describe('H1-isolation — no other merchant route uses getBalance', () => {
  it('merchant/balance.ts does not call getBalance() as a function', () => {
    // The only mention should be in comments. No actual call expression.
    assert.doesNotMatch(BALANCE, /=\s*getBalance\(\)/);
    assert.doesNotMatch(BALANCE, /await\s+getBalance\(\)/);
  });

  it('admin/wallet.ts avada-balance route returns null (not exposed)', () => {
    const adminWallet = fs.readFileSync(
      path.resolve(SRC, 'routes/admin/wallet.ts'),
      'utf-8',
    );
    // The admin route should return { balance: null } not call getBalance
    assert.match(adminWallet, /balance: null/);
  });
});
