/**
 * Unit tests for address-guard.ts
 *
 * Run with:  npm test
 *   (uses node:test + tsx — no extra test runner required)
 *
 * Covers the FORBIDDEN_ADDRESSES + format guards without requiring a live
 * Supabase client or BSC provider (supabase: null skips the whitelist,
 * and forbidden/invalid addresses are rejected before the on-chain check).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkDestinationAddress, FORBIDDEN_ADDRESSES } from '../address-guard.js';

/* ── Constants ───────────────────────────────────────────────────────── */
const USDT_BSC_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
const ZERO_ADDRESS      = '0x0000000000000000000000000000000000000000';
const VALID_EOA         = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1'; // random EOA

describe('address-guard — FORBIDDEN_ADDRESSES', () => {
  it('includes the USDT BEP-20 contract', () => {
    assert.ok(FORBIDDEN_ADDRESSES.has(USDT_BSC_CONTRACT.toLowerCase()));
  });

  it('includes the zero address', () => {
    assert.ok(FORBIDDEN_ADDRESSES.has(ZERO_ADDRESS));
  });
});

describe('address-guard — checkDestinationAddress', () => {

  it('blocks the USDT BEP-20 contract with FORBIDDEN_DESTINATION', async () => {
    const result = await checkDestinationAddress(USDT_BSC_CONTRACT, null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'FORBIDDEN_DESTINATION');
    }
  });

  it('blocks the zero address with FORBIDDEN_DESTINATION', async () => {
    const result = await checkDestinationAddress(ZERO_ADDRESS, null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'FORBIDDEN_DESTINATION');
    }
  });

  it('blocks an invalid address format with INVALID_ADDRESS', async () => {
    const result = await checkDestinationAddress('0xnotanaddress', null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'INVALID_ADDRESS');
    }
  });

  it('blocks a too-short address with INVALID_ADDRESS', async () => {
    const result = await checkDestinationAddress('0x1234', null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'INVALID_ADDRESS');
    }
  });

  it('rejects a forbidden address regardless of hex digit case', async () => {
    // Uppercase only the hex digits, keep the 0x prefix lowercase (regex requires 0x)
    const mixed = '0x' + USDT_BSC_CONTRACT.slice(2).toUpperCase();
    const result = await checkDestinationAddress(mixed, null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'FORBIDDEN_DESTINATION');
    }
  });

  /* ── Note: the VALID_EOA case would require a live BSC provider for the
   *    on-chain isContractAddress check (supabase: null → no whitelist
   *    bypass → provider call). Skipped here to keep the test hermetic.
   *    The guard logic for valid EOAs is exercised in integration tests. */
});
