"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const bsc_verify_js_1 = require("../bsc-verify.js");
/* ── Shared fixtures ─────────────────────────────────────────────────── */
const USDC_CONTRACT = bsc_verify_js_1.BSC_TOKEN_CONTRACTS.USDC.toLowerCase();
const USDT_CONTRACT = bsc_verify_js_1.BSC_TOKEN_CONTRACTS.USDT.toLowerCase();
const TREASURY_ADDR = '0xaabbccddee1122334455aabbccddee1122334455';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';
/** Pad a 20-byte EVM address to a 32-byte topic */
function padAddress(addr) {
    const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
    return '0x' + hex.padStart(64, '0');
}
/**
 * Encode a decimal USDC/USDT amount (18 decimals) to a 32-byte hex data field.
 * For test purposes amounts are whole numbers.
 */
function encodeAmount(units) {
    return '0x' + units.toString(16).padStart(64, '0');
}
/** Build a synthetic ERC-20 Transfer log */
function makeTransferLog(contractAddress, from, to, amountTokens) {
    const decimals = BigInt(10 ** 18);
    const rawAmount = BigInt(Math.round(amountTokens * 1e6)) * (decimals / BigInt(1e6));
    return {
        address: contractAddress,
        topics: [bsc_verify_js_1.TRANSFER_TOPIC, padAddress(from), padAddress(to)],
        data: encodeAmount(rawAmount),
    };
}
/** Build a successful tx receipt containing a single Transfer */
function successReceipt(contractAddress, from, to, amount) {
    return {
        status: '0x1',
        logs: [makeTransferLog(contractAddress, from, to, amount)],
    };
}
/* ══════════════════════════════════════════════════════════════════════
 * Helper unit tests
 * ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════
 * isTxSuccess / isTxFailed normalizer tests
 * ══════════════════════════════════════════════════════════════════════ */
(0, node_test_1.describe)('isTxSuccess / isTxFailed', () => {
    (0, node_test_1.it)('recognizes "0x1" as success', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)('0x1'), true);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)('0x1'), false);
    });
    (0, node_test_1.it)('recognizes numeric 1 as success', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)(1), true);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)(1), false);
    });
    (0, node_test_1.it)('recognizes string "1" as success', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)('1'), true);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)('1'), false);
    });
    (0, node_test_1.it)('recognizes "0x0" as failure', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)('0x0'), false);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)('0x0'), true);
    });
    (0, node_test_1.it)('recognizes numeric 0 as failure', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)(0), false);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)(0), true);
    });
    (0, node_test_1.it)('recognizes string "0" as failure', () => {
        strict_1.default.equal((0, bsc_verify_js_1.isTxSuccess)('0'), false);
        strict_1.default.equal((0, bsc_verify_js_1.isTxFailed)('0'), true);
    });
});
(0, node_test_1.describe)('decodeAddress', () => {
    (0, node_test_1.it)('strips left-padding from a 32-byte padded topic', () => {
        const padded = '0x000000000000000000000000aabbccddee1122334455aabbccddee1122334455';
        const decoded = (0, bsc_verify_js_1.decodeAddress)(padded);
        strict_1.default.equal(decoded, '0x' + 'aabbccddee1122334455aabbccddee1122334455');
    });
    (0, node_test_1.it)('handles input without 0x prefix', () => {
        const padded = '000000000000000000000000aabbccddee1122334455aabbccddee1122334455';
        strict_1.default.equal((0, bsc_verify_js_1.decodeAddress)(padded), '0xaabbccddee1122334455aabbccddee1122334455');
    });
});
(0, node_test_1.describe)('decodeUint256', () => {
    (0, node_test_1.it)('correctly decodes 116000 USDC (18 decimals)', () => {
        const raw = BigInt('116000') * BigInt(10 ** 18);
        const hex = '0x' + raw.toString(16).padStart(64, '0');
        strict_1.default.equal((0, bsc_verify_js_1.decodeUint256)(hex, 18), 116000);
    });
    (0, node_test_1.it)('correctly decodes 3 USDC (18 decimals)', () => {
        const raw = BigInt('3') * BigInt(10 ** 18);
        const hex = '0x' + raw.toString(16).padStart(64, '0');
        strict_1.default.equal((0, bsc_verify_js_1.decodeUint256)(hex, 18), 3);
    });
});
/* ══════════════════════════════════════════════════════════════════════
 * verifyBscTransfer — main business logic tests
 * ══════════════════════════════════════════════════════════════════════ */
(0, node_test_1.describe)('verifyBscTransfer', () => {
    /* ── Case 1: matching amount ───────────────────────────────────────── */
    (0, node_test_1.it)('Case 1 — matching amount confirms OK', () => {
        const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, true, 'should be verified');
        strict_1.default.equal(result.tx_success, true);
        strict_1.default.equal(result.contract_match, true);
        strict_1.default.equal(result.recipient_match, true);
        strict_1.default.equal(result.amount_match, true);
        strict_1.default.deepEqual(result.blocking_reasons, []);
        strict_1.default.equal(result.reason, 'OK');
    });
    /* ── Case 2: wrong amount blocks confirmation ──────────────────────── */
    (0, node_test_1.it)('Case 2 — wrong amount blocks confirmation (3 sent, 5 expected)', () => {
        const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 3);
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 5);
        strict_1.default.equal(result.verified, false, 'should NOT be verified');
        strict_1.default.equal(result.amount_match, false);
        strict_1.default.equal(result.recipient_match, true, 'recipient should still match');
        strict_1.default.equal(result.contract_match, true, 'contract should still match');
        strict_1.default.ok(result.blocking_reasons.includes('AMOUNT_MISMATCH'), 'should include AMOUNT_MISMATCH');
        strict_1.default.ok(result.reason.includes('mismatch'), 'reason should mention mismatch');
        strict_1.default.equal(result.transferred_amount, 3);
        strict_1.default.equal(result.expected_amount, 5);
    });
    /* ── Case 3: wrong recipient blocks confirmation ───────────────────── */
    (0, node_test_1.it)('Case 3 — wrong recipient blocks confirmation', () => {
        const wrongAddr = OTHER_ADDR;
        const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, wrongAddr, 116000);
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, false, 'should NOT be verified');
        strict_1.default.equal(result.recipient_match, false);
        strict_1.default.equal(result.contract_match, true);
        strict_1.default.ok(result.blocking_reasons.includes('RECIPIENT_MISMATCH'));
        strict_1.default.ok(result.reason.includes(TREASURY_ADDR));
    });
    /* ── Case 4: wrong token contract blocks confirmation ─────────────── */
    (0, node_test_1.it)('Case 4 — wrong token contract blocks confirmation (USDT log vs USDC receipt)', () => {
        // Receipt expects USDC but the log is from USDT contract
        const receipt = successReceipt(USDT_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, false, 'should NOT be verified');
        strict_1.default.equal(result.contract_match, false, 'contract should not match');
        strict_1.default.ok(result.blocking_reasons.includes('NO_TRANSFER_LOG'));
        strict_1.default.ok(result.reason.toLowerCase().includes('usdc'));
    });
    /* ── Case 5a: failed tx (status "0x0") ────────────────────────────── */
    (0, node_test_1.it)('Case 5a — status "0x0" is blocked', () => {
        const receipt = { status: '0x0', logs: [makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000)] };
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, false);
        strict_1.default.equal(result.tx_success, false);
        strict_1.default.ok(result.blocking_reasons.includes('TX_FAILED'));
        strict_1.default.ok(result.reason.includes('0x0'));
    });
    /* ── Case 5b: failed tx (numeric status 0) ─────────────────────────── */
    (0, node_test_1.it)('Case 5b — numeric status 0 is blocked', () => {
        const receipt = { status: 0, logs: [makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000)] };
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, false);
        strict_1.default.equal(result.tx_success, false);
        strict_1.default.ok(result.blocking_reasons.includes('TX_FAILED'));
    });
    /* ── Case 5c: successful tx with numeric status 1 (not "0x1") ──────── */
    (0, node_test_1.it)('Case 5c — numeric status 1 is treated as success (not TX_FAILED)', () => {
        const receipt = { status: 1, logs: [makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000)] };
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.tx_success, true, 'numeric 1 must be recognized as success');
        strict_1.default.equal(result.verified, true);
        strict_1.default.ok(!result.blocking_reasons.includes('TX_FAILED'), 'should NOT have TX_FAILED');
    });
    /* ── Case 5d: successful tx with string status "1" (regression) ─────── */
    (0, node_test_1.it)('Case 5d — string "1" is treated as success (original bug regression)', () => {
        const receipt = { status: '1', logs: [makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000)] };
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.tx_success, true, 'string "1" must be recognized as success');
        strict_1.default.equal(result.verified, true);
        strict_1.default.ok(!result.blocking_reasons.includes('TX_FAILED'));
    });
    /* ── Case 6: amount within tolerance passes ────────────────────────── */
    (0, node_test_1.it)('Case 6 — transferred amount within 0.01 tolerance passes', () => {
        // 116000.005 USDC → difference is 0.005, within AMOUNT_TOLERANCE (0.01)
        const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000.005);
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, true);
        strict_1.default.equal(result.amount_match, true);
    });
    /* ── Case 7: duplicate tx_hash is a DB concern, not verify concern ─── */
    (0, node_test_1.it)('Case 7 — verifyBscTransfer has no duplicate-tx-hash logic (DB handles it)', () => {
        // This test documents the boundary: uniqueness is enforced at the DB insert layer,
        // not in the pure verify function. verifyBscTransfer is idempotent.
        const receipt = successReceipt(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000);
        const r1 = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        const r2 = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.deepEqual(r1, r2, 'same call must be idempotent');
    });
    /* ── Case 8: multiple Transfer logs in one tx (e.g. DEX swap) ─────── */
    (0, node_test_1.it)('Case 8 — correct transfer found among multiple logs in same tx', () => {
        const receipt = {
            status: '0x1',
            logs: [
                makeTransferLog(USDC_CONTRACT, OTHER_ADDR, OTHER_ADDR, 50000), // irrelevant
                makeTransferLog(USDC_CONTRACT, OTHER_ADDR, TREASURY_ADDR, 116000), // the one we care about
            ],
        };
        const result = (0, bsc_verify_js_1.verifyBscTransfer)(receipt, 'USDC', TREASURY_ADDR, 116000);
        strict_1.default.equal(result.verified, true);
        strict_1.default.equal(result.recipient_match, true);
        strict_1.default.equal(result.transferred_amount, 116000);
    });
});
//# sourceMappingURL=bsc-verify.test.js.map