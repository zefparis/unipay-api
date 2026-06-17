/**
 * Unit tests for bsc-verify.ts
 *
 * Run with:  npm test
 *   (uses node:test + tsx — no extra test runner required)
 *
 * Covers:
 *  1. Matching amount → verified: true
 *  2. Wrong amount   → verified: false, AMOUNT_MISMATCH
 *  3. Wrong recipient → verified: false, RECIPIENT_MISMATCH
 *  4. Wrong token contract → verified: false, NO_TRANSFER_LOG
 *  5. Failed tx (status 0x0) → verified: false, TX_FAILED
 *  6. decodeAddress helper
 *  7. decodeUint256 helper
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyBscTransfer,
  decodeAddress,
  decodeUint256,
  TRANSFER_TOPIC,
  BSC_TOKEN_CONTRACTS,
} from '../bsc-verify.js';

/* ── Shared fixtures ─────────────────────────────────────────────────── */

const USDC_CONTRACT = BSC_TOKEN_CONTRACTS.USDC.toLowerCase();
const USDT_CONTRACT = BSC_TOKEN_CONTRACTS.USDT.toLowerCase();

const TREASURY_ADDR = '0xaabbccddee1122334455aabbccddee1122334455';
const OTHER_ADDR    = '0x1111111111111111111111111111111111111111';

/** Pad a 20-byte EVM address to a 32-byte topic */
function padAddress(addr: string): string {
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  return '0x' + hex.padStart(64, '0');
}

/**
 * Encode a decimal USDC/USDT amount (18 decimals) to a 32-byte hex data field.
 * For test purposes amounts are whole numbers.
 */
function encodeAmount(units: bigint): string {
  return '0x' + units.toString(16).padStart(64, '0');
}

/** Build a synthetic ERC-20 Transfer log */
function makeTransferLog(
  contractAddress: string,
  from:            string,
  to:              string,
  amountTokens:    number,
): { address: string; topics: string[]; data: string } {
  const decimals = BigInt(10 ** 18);
  const rawAmount = BigInt(Math.round(amountTokens * 1e6)) * (decimals / BigInt(1e6));
  return {
    address: contractAddress,
    topics:  [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    data:    encodeAmount(rawAmount),
  };
}

/** Build a successful tx receipt containing a single Transfer */
function successReceipt(
  contractAddress: string,
  from:            string,
  to:              string,
  amount:          number,
) {
  return {
    status: '0x1' as const,
    logs:   [makeTransferLog(contractAddress, from, to, amount)],
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * Helper unit tests
 * ══════════════════════════════════════════════════════════════════════ */

describe('decodeAddress', () => {
  it('strips left-padding from a 32-byte padded topic', () => {
    const padded  = '0x000000000000000000000000aabbccddee1122334455aabbccddee1122334455';
    const decoded = decodeAddress(padded);
    assert.equal(decoded, '0x' + 'aabbccddee1122334455aabbccddee1122334455');
  });

  it('handles input without 0x prefix', () => {
    const padded  = '000000000000000000000000aabbccddee1122334455aabbccddee1122334455';
    assert.equal(decodeAddress(padded), '0xaabbccddee1122334455aabbccddee1122334455');
  });
});

describe('decodeUint256', () => {
  it('correctly decodes 116000 USDC (18 decimals)', () => {
    const raw = BigInt('116000') * BigInt(10 ** 18);
    const hex = '0x' + raw.toString(16).padStart(64, '0');
    assert.equal(decodeUint256(hex, 18), 116000);
  });

  it('correctly decodes 3 USDC (18 decimals)', () => {
    const raw = BigInt('3') * BigInt(10 ** 18);
    const hex = '0x' + raw.toString(16).padStart(64, '0');
    assert.equal(decodeUint256(hex, 18), 3);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * verifyBscTransfer — main business logic tests
 * ══════════════════════════════════════════════════════════════════════ */

describe('verifyBscTransfer', () => {

  /* ── Case 1: matching amount ───────────────────────────────────────── */
  it('Case 1 — matching amount confirms OK', () => {
    const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
    const result  = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);

    assert.equal(result.verified,       true,  'should be verified');
    assert.equal(result.tx_success,     true);
    assert.equal(result.contract_match, true);
    assert.equal(result.recipient_match,true);
    assert.equal(result.amount_match,   true);
    assert.deepEqual(result.blocking_reasons, []);
    assert.equal(result.reason, 'OK');
  });

  /* ── Case 2: wrong amount blocks confirmation ──────────────────────── */
  it('Case 2 — wrong amount blocks confirmation (3 sent, 5 expected)', () => {
    const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 3);
    const result  = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 5);

    assert.equal(result.verified,       false, 'should NOT be verified');
    assert.equal(result.amount_match,   false);
    assert.equal(result.recipient_match,true,  'recipient should still match');
    assert.equal(result.contract_match, true,  'contract should still match');
    assert.ok(result.blocking_reasons.includes('AMOUNT_MISMATCH'), 'should include AMOUNT_MISMATCH');
    assert.ok(result.reason.includes('mismatch'), 'reason should mention mismatch');
    assert.equal(result.transferred_amount, 3);
    assert.equal(result.expected_amount,    5);
  });

  /* ── Case 3: wrong recipient blocks confirmation ───────────────────── */
  it('Case 3 — wrong recipient blocks confirmation', () => {
    const wrongAddr = OTHER_ADDR;
    const receipt   = successReceipt(USDC_CONTRACT, OTHER_ADDR, wrongAddr, 116000);
    const result    = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);

    assert.equal(result.verified,        false, 'should NOT be verified');
    assert.equal(result.recipient_match, false);
    assert.equal(result.contract_match,  true);
    assert.ok(result.blocking_reasons.includes('RECIPIENT_MISMATCH'));
    assert.ok(result.reason.includes(TREASURY_ADDR));
  });

  /* ── Case 4: wrong token contract blocks confirmation ─────────────── */
  it('Case 4 — wrong token contract blocks confirmation (USDT log vs USDC receipt)', () => {
    // Receipt expects USDC but the log is from USDT contract
    const receipt = successReceipt(USDT_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
    const result  = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);

    assert.equal(result.verified,       false, 'should NOT be verified');
    assert.equal(result.contract_match, false, 'contract should not match');
    assert.ok(result.blocking_reasons.includes('NO_TRANSFER_LOG'));
    assert.ok(result.reason.toLowerCase().includes('usdc'));
  });

  /* ── Case 5: failed tx (status 0x0) ───────────────────────────────── */
  it('Case 5 — failed transaction is blocked', () => {
    const receipt = {
      status: '0x0' as const,
      logs:   [makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000)],
    };
    const result = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);

    assert.equal(result.verified,   false, 'should NOT be verified');
    assert.equal(result.tx_success, false);
    assert.ok(result.blocking_reasons.includes('TX_FAILED'));
    assert.ok(result.reason.toLowerCase().includes('revert'));
  });

  /* ── Case 6: amount within tolerance passes ────────────────────────── */
  it('Case 6 — transferred amount within 0.01 tolerance passes', () => {
    // 116000.005 USDC → difference is 0.005, within AMOUNT_TOLERANCE (0.01)
    const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000.005);
    const result  = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);

    assert.equal(result.verified,    true);
    assert.equal(result.amount_match,true);
  });

  /* ── Case 7: duplicate tx_hash is a DB concern, not verify concern ─── */
  it('Case 7 — verifyBscTransfer has no duplicate-tx-hash logic (DB handles it)', () => {
    // This test documents the boundary: uniqueness is enforced at the DB insert layer,
    // not in the pure verify function. verifyBscTransfer is idempotent.
    const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
    const r1 = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);
    const r2 = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);
    assert.deepEqual(r1, r2, 'same call must be idempotent');
  });

  /* ── Case 8: multiple Transfer logs in one tx (e.g. DEX swap) ─────── */
  it('Case 8 — correct transfer found among multiple logs in same tx', () => {
    const receipt = {
      status: '0x1' as const,
      logs: [
        makeTransferLog(USDC_CONTRACT, OTHER_ADDR, OTHER_ADDR,    50000),   // irrelevant
        makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000),  // the one we care about
      ],
    };
    const result = verifyBscTransfer(receipt, 'USDC', TREASURY_ADDR, 116000);
    assert.equal(result.verified,       true);
    assert.equal(result.recipient_match,true);
    assert.equal(result.transferred_amount, 116000);
  });
});
