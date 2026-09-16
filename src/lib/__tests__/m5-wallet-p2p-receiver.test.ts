import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const P2P = fs.readFileSync(path.resolve(SRC, 'routes/wallet/p2p.ts'), 'utf-8');
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260927000000_wallet_p2p_receiver_check.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('M5-migration — wallet_p2p receiver check', () => {
  it('re-creates wallet_p2p function', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.wallet_p2p/i);
  });

  it('is SECURITY DEFINER', () => {
    assert.match(MIGRATION, /wallet_p2p[\s\S]*?SECURITY DEFINER/);
  });

  it('sets search_path = public', () => {
    assert.match(MIGRATION, /wallet_p2p[\s\S]*?SET search_path = public/);
  });

  it('preserves the sender debit with INSUFFICIENT_FUNDS check', () => {
    assert.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf - p_amount/i);
    assert.match(MIGRATION, /WHERE id\s+= p_sender_id[\s\S]*?AND balance_cdf >= p_amount[\s\S]*?AND is_active = true/i);
    assert.match(MIGRATION, /IF NOT FOUND THEN\s+RAISE EXCEPTION 'INSUFFICIENT_FUNDS'/);
  });

  it('preserves the receiver credit', () => {
    assert.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf \+ p_amount/i);
    assert.match(MIGRATION, /WHERE id\s+= p_receiver_id[\s\S]*?AND is_active = true/i);
  });

  it('adds IF NOT FOUND check after receiver credit (M5 fix)', () => {
    // The fix: after the receiver credit UPDATE, check IF NOT FOUND
    // and raise RECEIVER_INACTIVE. This rolls back the sender debit.
    assert.match(MIGRATION, /UPDATE wallet_users\s+SET balance_cdf = balance_cdf \+ p_amount[\s\S]*?IF NOT FOUND THEN\s+RAISE EXCEPTION 'RECEIVER_INACTIVE'/);
  });

  it('raises RECEIVER_INACTIVE error', () => {
    assert.match(MIGRATION, /RECEIVER_INACTIVE/);
  });

  it('the RECEIVER_INACTIVE check comes AFTER the receiver credit UPDATE', () => {
    // Strip comment lines to find actual code positions
    const code = MIGRATION
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const creditPos = code.indexOf('balance_cdf = balance_cdf + p_amount');
    const checkPos = code.indexOf("RECEIVER_INACTIVE");
    assert.ok(creditPos > -1, 'must find receiver credit UPDATE');
    assert.ok(checkPos > -1, 'must find RECEIVER_INACTIVE check');
    assert.ok(creditPos < checkPos, 'RECEIVER_INACTIVE check must come AFTER the receiver credit');
  });

  it('the RECEIVER_INACTIVE check comes AFTER the INSUFFICIENT_FUNDS check', () => {
    // Strip comment lines to find actual code positions
    const code = MIGRATION
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const insufficientPos = code.indexOf("INSUFFICIENT_FUNDS");
    const inactivePos = code.indexOf("RECEIVER_INACTIVE");
    assert.ok(insufficientPos > -1);
    assert.ok(inactivePos > -1);
    assert.ok(insufficientPos < inactivePos, 'INSUFFICIENT_FUNDS check (sender) must come BEFORE RECEIVER_INACTIVE check (receiver)');
  });

  it('revokes PUBLIC and grants service_role', () => {
    assert.match(MIGRATION, /REVOKE ALL ON FUNCTION public\.wallet_p2p\(uuid, uuid, numeric\) FROM PUBLIC/);
    assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION public\.wallet_p2p\(uuid, uuid, numeric\) TO service_role/);
  });
});

// ── p2p.ts tests ─────────────────────────────────────────────

describe('M5-p2p — handles RECEIVER_INACTIVE error', () => {
  it('handles RECEIVER_INACTIVE error (403)', () => {
    assert.match(P2P, /RECEIVER_INACTIVE/);
    assert.match(P2P, /403/);
  });

  it('returns "Recipient account is suspended" for RECEIVER_INACTIVE', () => {
    assert.match(P2P, /Recipient account is suspended/);
  });

  it('preserves INSUFFICIENT_FUNDS handling (402)', () => {
    assert.match(P2P, /INSUFFICIENT_FUNDS/);
    assert.match(P2P, /402/);
  });

  it('RECEIVER_INACTIVE check comes before the generic fallback', () => {
    // The RECEIVER_INACTIVE check must come before the generic
    // isInsufficient ? 402 : 500 fallback.
    const inactivePos = P2P.indexOf('RECEIVER_INACTIVE');
    const fallbackPos = P2P.indexOf("isInsufficient ? 402 : 500");
    assert.ok(inactivePos > -1);
    assert.ok(fallbackPos > -1);
    assert.ok(inactivePos < fallbackPos, 'RECEIVER_INACTIVE check must come before the generic fallback');
  });
});
