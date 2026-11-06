"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const address_guard_js_1 = require("../address-guard.js");
/* ── Constants ───────────────────────────────────────────────────────── */
const USDT_BSC_CONTRACT = '0x55d398326f99059ff775485246999027b3197955';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const VALID_EOA = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1'; // random EOA
(0, node_test_1.describe)('address-guard — FORBIDDEN_ADDRESSES', () => {
    (0, node_test_1.it)('includes the USDT BEP-20 contract', () => {
        strict_1.default.ok(address_guard_js_1.FORBIDDEN_ADDRESSES.has(USDT_BSC_CONTRACT.toLowerCase()));
    });
    (0, node_test_1.it)('includes the zero address', () => {
        strict_1.default.ok(address_guard_js_1.FORBIDDEN_ADDRESSES.has(ZERO_ADDRESS));
    });
});
(0, node_test_1.describe)('address-guard — checkDestinationAddress', () => {
    (0, node_test_1.it)('blocks the USDT BEP-20 contract with FORBIDDEN_DESTINATION', async () => {
        const result = await (0, address_guard_js_1.checkDestinationAddress)(USDT_BSC_CONTRACT, null);
        strict_1.default.equal(result.ok, false);
        if (!result.ok) {
            strict_1.default.equal(result.status, 400);
            strict_1.default.equal(result.body.error, 'FORBIDDEN_DESTINATION');
        }
    });
    (0, node_test_1.it)('blocks the zero address with FORBIDDEN_DESTINATION', async () => {
        const result = await (0, address_guard_js_1.checkDestinationAddress)(ZERO_ADDRESS, null);
        strict_1.default.equal(result.ok, false);
        if (!result.ok) {
            strict_1.default.equal(result.status, 400);
            strict_1.default.equal(result.body.error, 'FORBIDDEN_DESTINATION');
        }
    });
    (0, node_test_1.it)('blocks an invalid address format with INVALID_ADDRESS', async () => {
        const result = await (0, address_guard_js_1.checkDestinationAddress)('0xnotanaddress', null);
        strict_1.default.equal(result.ok, false);
        if (!result.ok) {
            strict_1.default.equal(result.status, 400);
            strict_1.default.equal(result.body.error, 'INVALID_ADDRESS');
        }
    });
    (0, node_test_1.it)('blocks a too-short address with INVALID_ADDRESS', async () => {
        const result = await (0, address_guard_js_1.checkDestinationAddress)('0x1234', null);
        strict_1.default.equal(result.ok, false);
        if (!result.ok) {
            strict_1.default.equal(result.status, 400);
            strict_1.default.equal(result.body.error, 'INVALID_ADDRESS');
        }
    });
    (0, node_test_1.it)('rejects a forbidden address regardless of hex digit case', async () => {
        // Uppercase only the hex digits, keep the 0x prefix lowercase (regex requires 0x)
        const mixed = '0x' + USDT_BSC_CONTRACT.slice(2).toUpperCase();
        const result = await (0, address_guard_js_1.checkDestinationAddress)(mixed, null);
        strict_1.default.equal(result.ok, false);
        if (!result.ok) {
            strict_1.default.equal(result.status, 400);
            strict_1.default.equal(result.body.error, 'FORBIDDEN_DESTINATION');
        }
    });
    /* ── Note: the VALID_EOA case would require a live BSC provider for the
     *    on-chain isContractAddress check (supabase: null → no whitelist
     *    bypass → provider call). Skipped here to keep the test hermetic.
     *    The guard logic for valid EOAs is exercised in integration tests. */
});
//# sourceMappingURL=address-guard.test.js.map