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
export {};
