import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const RECONCILE = fs.readFileSync(path.resolve(SRC, 'routes/admin/wallet-reconcile.ts'), 'utf-8');
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260926000000_atomic_wallet_reconcile.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('M4-migration — wallet_reconcile_atomic RPC', () => {
  it('creates the RPC', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_reconcile_atomic/i);
  });

  it('is SECURITY DEFINER', () => {
    assert.match(MIGRATION, /wallet_reconcile_atomic[\s\S]*?SECURITY DEFINER/);
  });

  it('accepts p_tx_id, p_target_status, p_delta parameters', () => {
    assert.match(MIGRATION, /p_tx_id\s+UUID/);
    assert.match(MIGRATION, /p_target_status\s+TEXT/);
    assert.match(MIGRATION, /p_delta\s+NUMERIC/);
  });

  it('locks the transaction row with FOR UPDATE', () => {
    assert.match(MIGRATION, /wallet_reconcile_atomic[\s\S]*?FOR UPDATE/);
  });

  it('checks if status is already terminal (idempotence)', () => {
    assert.match(MIGRATION, /already_terminal/);
    assert.match(MIGRATION, /v_tx\.status = 'success' OR v_tx\.status = 'failed'/);
  });

  it('returns already_terminal=true without crediting on terminal status', () => {
    // The already_terminal branch must return before any balance update
    assert.match(MIGRATION, /already_terminal[\s\S]*?RETURN jsonb_build_object/);
  });

  it('updates transaction status atomically', () => {
    assert.match(MIGRATION, /UPDATE public\.transactions\s+SET status = p_target_status/);
  });

  it('credits wallet balance inside the same transaction', () => {
    assert.match(MIGRATION, /UPDATE public\.wallet_users\s+SET balance_cdf = balance_cdf \+ p_delta/);
  });

  it('raises TRANSACTION_NOT_FOUND when tx does not exist', () => {
    assert.match(MIGRATION, /TRANSACTION_NOT_FOUND/);
  });

  it('raises WALLET_NOT_FOUND when wallet does not exist', () => {
    assert.match(MIGRATION, /WALLET_NOT_FOUND/);
  });

  it('raises INVALID_TARGET_STATUS for invalid status', () => {
    assert.match(MIGRATION, /INVALID_TARGET_STATUS/);
  });

  it('grants EXECUTE to service_role', () => {
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_reconcile_atomic\(UUID, TEXT, NUMERIC\) TO service_role/);
  });
});

// ── wallet-reconcile.ts tests ────────────────────────────────

describe('M4-reconcile — uses atomic RPC (no TOCTOU)', () => {
  it('calls wallet_reconcile_atomic RPC', () => {
    assert.match(RECONCILE, /wallet_reconcile_atomic/);
  });

  it('passes p_tx_id, p_target_status, p_delta', () => {
    assert.match(RECONCILE, /p_tx_id:\s*tx\.id/);
    assert.match(RECONCILE, /p_target_status:\s*targetStatus/);
    assert.match(RECONCILE, /p_delta:\s*delta/);
  });

  it('handles already_terminal idempotent return', () => {
    assert.match(RECONCILE, /already_terminal/);
    assert.match(RECONCILE, /Already/);
  });

  it('handles TRANSACTION_NOT_FOUND error (404)', () => {
    assert.match(RECONCILE, /TRANSACTION_NOT_FOUND/);
    assert.match(RECONCILE, /404/);
  });

  it('handles WALLET_NOT_FOUND error (404)', () => {
    assert.match(RECONCILE, /WALLET_NOT_FOUND/);
    assert.match(RECONCILE, /404/);
  });

  it('does NOT call wallet_credit_cdf directly (old TOCTOU path)', () => {
    // The old code called wallet_credit_cdf separately after the status
    // check. The new code does both atomically in the RPC.
    // Strip comments before checking.
    const stripped = RECONCILE
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(stripped, /rpc\('wallet_credit_cdf'/);
  });

  it('does NOT do a separate status check + early return before the RPC', () => {
    // The old code did: if (tx.status === 'success' || tx.status === 'failed') return ...
    // BEFORE calling the credit RPC. The new code delegates this check to
    // the atomic RPC (which does it under FOR UPDATE lock).
    // Strip comments before checking.
    const stripped = RECONCILE
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Should not find the old pattern of checking tx.status then returning early
    assert.doesNotMatch(stripped, /if \(tx\.status === 'success' \|\| tx\.status === 'failed'\)\s*\{[\s\S]*?return reply/);
  });

  it('the atomic RPC call happens BEFORE logAdminAction', () => {
    // The debit must happen before the audit log (the log records the result).
    // Find the logAdminAction CALL (not the import).
    const rpcPos = RECONCILE.indexOf('wallet_reconcile_atomic');
    const logPos = RECONCILE.indexOf("void logAdminAction(");
    assert.ok(rpcPos > -1, 'must find atomic RPC call');
    assert.ok(logPos > -1, 'must find logAdminAction call');
    assert.ok(rpcPos < logPos, 'atomic RPC must run BEFORE logAdminAction');
  });

  it('logs via logAdminAction with reconcile details', () => {
    assert.match(RECONCILE, /logAdminAction\([\s\S]*?'wallet\.reconcile'/);
    assert.match(RECONCILE, /logAdminAction\([\s\S]*?'transaction'/);
    assert.match(RECONCILE, /logAdminAction\([\s\S]*?previous_status/);
    assert.match(RECONCILE, /logAdminAction\([\s\S]*?new_status/);
  });
});
