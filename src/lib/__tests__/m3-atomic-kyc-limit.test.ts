import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const WITHDRAW = fs.readFileSync(path.resolve(SRC, 'routes/wallet/withdraw.ts'), 'utf-8');
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260925000000_atomic_kyc_limit.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('M3-migration — wallet_debit_with_kyc_limit RPC', () => {
  it('creates the RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_debit_with_kyc_limit/i);
  });

  it('is SECURITY DEFINER', () => {
    assert.match(MIGRATION, /wallet_debit_with_kyc_limit[\s\S]*?SECURITY DEFINER/);
  });

  it('accepts p_user_id, p_amount, p_daily_limit parameters', () => {
    assert.match(MIGRATION, /p_user_id\s+UUID/);
    assert.match(MIGRATION, /p_amount\s+NUMERIC/);
    assert.match(MIGRATION, /p_daily_limit\s+NUMERIC/);
  });

  it('locks the wallet row with FOR UPDATE', () => {
    assert.match(MIGRATION, /wallet_debit_with_kyc_limit[\s\S]*?FOR UPDATE/);
  });

  it('computes daily cumulative payout from transactions', () => {
    assert.match(MIGRATION, /direction = 'payout'/);
    assert.match(MIGRATION, /status IN \('processing', 'success'\)/);
    assert.match(MIGRATION, /date_trunc\('day', now\(\)\)/);
  });

  it('raises KYC_LIMIT_EXCEEDED when daily limit exceeded', () => {
    assert.match(MIGRATION, /KYC_LIMIT_EXCEEDED/);
  });

  it('raises INSUFFICIENT_FUNDS when balance too low', () => {
    assert.match(MIGRATION, /INSUFFICIENT_FUNDS/);
  });

  it('raises WALLET_SUSPENDED when account inactive', () => {
    assert.match(MIGRATION, /WALLET_SUSPENDED/);
  });

  it('raises WALLET_NOT_FOUND when wallet does not exist', () => {
    assert.match(MIGRATION, /WALLET_NOT_FOUND/);
  });

  it('debits balance_cdf atomically', () => {
    assert.match(MIGRATION, /balance_cdf = v_new_balance/);
    assert.match(MIGRATION, /v_new_balance := v_wallet\.balance_cdf - p_amount/);
  });

  it('returns JSONB with new_balance and daily_used', () => {
    assert.match(MIGRATION, /jsonb_build_object/);
    assert.match(MIGRATION, /new_balance/);
    assert.match(MIGRATION, /daily_used_before/);
    assert.match(MIGRATION, /daily_used_after/);
  });

  it('grants EXECUTE to service_role', () => {
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_debit_with_kyc_limit TO service_role/);
  });
});

// ── withdraw.ts tests ────────────────────────────────────────

describe('M3-withdraw — uses atomic RPC (no TOCTOU)', () => {
  it('calls wallet_debit_with_kyc_limit RPC', () => {
    assert.match(WITHDRAW, /wallet_debit_with_kyc_limit/);
  });

  it('passes p_daily_limit from KYC limits', () => {
    assert.match(WITHDRAW, /p_daily_limit:\s*limits\.withdraw_daily/);
  });

  it('handles KYC_LIMIT_EXCEEDED error (403)', () => {
    assert.match(WITHDRAW, /KYC_LIMIT_EXCEEDED/);
    assert.match(WITHDRAW, /403/);
  });

  it('handles INSUFFICIENT_FUNDS error (402)', () => {
    assert.match(WITHDRAW, /INSUFFICIENT_FUNDS/);
    assert.match(WITHDRAW, /402/);
  });

  it('handles WALLET_SUSPENDED error (403)', () => {
    assert.match(WITHDRAW, /WALLET_SUSPENDED/);
    assert.match(WITHDRAW, /403/);
  });

  it('does NOT call the old wallet_debit RPC', () => {
    // The old wallet_debit RPC should no longer be called — the new
    // RPC does both the KYC check and the debit atomically.
    // Strip comments before checking.
    const stripped = WITHDRAW
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(stripped, /rpc\('wallet_debit'/);
  });

  it('does NOT do a separate SELECT for daily cumulative (TOCTOU eliminated)', () => {
    // The old code did a separate SELECT to compute dailyUsed before
    // the debit. The new code does this inside the RPC atomically.
    // Strip comments before checking.
    const stripped = WITHDRAW
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Should not find the old pattern of selecting transactions to compute dailyUsed
    assert.doesNotMatch(stripped, /from\('transactions'\)[\s\S]*?\.eq\('direction', 'payout'\)[\s\S]*?dailyUsed/);
  });

  it('the atomic RPC call happens BEFORE the transaction insert', () => {
    // The debit must happen before the transaction insert (same as
    // the old flow — debit first, then insert the transaction record).
    const rpcPos = WITHDRAW.indexOf('wallet_debit_with_kyc_limit');
    const insertPos = WITHDRAW.indexOf("from('transactions')");
    assert.ok(rpcPos > -1, 'must find atomic RPC call');
    assert.ok(insertPos > -1, 'must find transaction insert');
    assert.ok(
      rpcPos < insertPos,
      'atomic debit+KYC RPC must run BEFORE transaction insert',
    );
  });
});
