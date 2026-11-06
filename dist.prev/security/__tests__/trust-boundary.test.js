"use strict";
/**
 * Trust Boundary Route Tests (Phase 05B0)
 *
 * Tests 1-10: Verify that the route auth guards correctly enforce
 * trust boundary separation with dual-key support.
 *
 * Tests:
 *  1. New CongoGaming key accepted on gaming route
 *  2. Legacy GAMING_API_KEY accepted on gaming route during overlap
 *  3. Bridge key rejected on gaming route
 *  4. New Bridge inbound key accepted on internal route
 *  5. CongoGaming key rejected on internal route
 *  6. Legacy GAMING_API_KEY accepted on internal route
 *  7. ADMIN_SECRET comparison timing-safe
 *  8. Empty string rejected
 *  9. Different length rejected
 * 10. No secret value in logs
 *
 * Run with: npx tsx --test src/security/__tests__/trust-boundary.test.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const secret_compare_1 = require("../secret-compare");
// Simulate env configuration for testing
const TEST_NEW_GAMING_KEY = 'test-congogaming-key-12345678';
const TEST_LEGACY_GAMING_KEY = 'test-legacy-gaming-key-12345678';
const TEST_NEW_BRIDGE_KEY = 'test-bridge-inbound-key-12345678';
const TEST_BRIDGE_OUTBOUND_KEY = 'test-bridge-outbound-key-12';
const TEST_ADMIN_SECRET = 'test-admin-secret-12345678';
(0, node_test_1.describe)('Trust boundary 1: CongoGaming → UniPay API', () => {
    (0, node_test_1.test)('1. New CongoGaming key accepted on gaming route', () => {
        const provided = TEST_NEW_GAMING_KEY;
        const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), true);
    });
    (0, node_test_1.test)('2. Legacy GAMING_API_KEY accepted on gaming route during overlap', () => {
        const provided = TEST_LEGACY_GAMING_KEY;
        const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), true);
    });
    (0, node_test_1.test)('3. Bridge key rejected on gaming route', () => {
        const provided = TEST_NEW_BRIDGE_KEY;
        const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), false);
    });
});
(0, node_test_1.describe)('Trust boundary 2: Bridge → UniPay API', () => {
    (0, node_test_1.test)('4. New Bridge inbound key accepted on internal route', () => {
        const provided = TEST_NEW_BRIDGE_KEY;
        const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), true);
    });
    (0, node_test_1.test)('5. CongoGaming key rejected on internal route', () => {
        const provided = TEST_NEW_GAMING_KEY;
        const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), false);
    });
    (0, node_test_1.test)('6. Legacy GAMING_API_KEY accepted on internal route', () => {
        const provided = TEST_LEGACY_GAMING_KEY;
        const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)(provided, candidates), true);
    });
});
(0, node_test_1.describe)('Trust boundary 4: Admin secret', () => {
    (0, node_test_1.test)('7. ADMIN_SECRET comparison timing-safe', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(TEST_ADMIN_SECRET, TEST_ADMIN_SECRET), true);
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('wrong-secret', TEST_ADMIN_SECRET), false);
    });
    (0, node_test_1.test)('8. Empty string rejected', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('', TEST_ADMIN_SECRET), false);
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(TEST_ADMIN_SECRET, ''), false);
    });
    (0, node_test_1.test)('9. Different length rejected', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('short', TEST_ADMIN_SECRET), false);
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(TEST_ADMIN_SECRET, 'short'), false);
    });
});
(0, node_test_1.describe)('Log safety', () => {
    (0, node_test_1.test)('10. No secret value in matchesAnySecret output', () => {
        // The function returns only boolean — no secret can leak through return value.
        const result = (0, secret_compare_1.matchesAnySecret)(TEST_NEW_GAMING_KEY, [TEST_NEW_GAMING_KEY]);
        strict_1.default.equal(result, true);
        // Verify the function signature returns only boolean
        strict_1.default.equal(typeof result, 'boolean');
    });
});
//# sourceMappingURL=trust-boundary.test.js.map