"use strict";
/**
 * Trust Boundary Patch Tests (Phase 05B0)
 *
 * Tests 1-10: Verify trust boundary separation, dual-key support,
 * timing-safe comparisons, and cross-boundary key rejection.
 *
 * Run with: npx tsx --test src/security/__tests__/secret-compare.test.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const secret_compare_1 = require("../secret-compare");
(0, node_test_1.describe)('safeSecretEqual', () => {
    (0, node_test_1.test)('returns true for identical strings', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('secret123', 'secret123'), true);
    });
    (0, node_test_1.test)('returns false for different strings', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('secret123', 'secret456'), false);
    });
    (0, node_test_1.test)('returns false for empty provided', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('', 'expected'), false);
    });
    (0, node_test_1.test)('returns false for empty expected', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('provided', ''), false);
    });
    (0, node_test_1.test)('returns false for undefined provided', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(undefined, 'expected'), false);
    });
    (0, node_test_1.test)('returns false for null provided', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(null, 'expected'), false);
    });
    (0, node_test_1.test)('returns false for undefined expected', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('provided', undefined), false);
    });
    (0, node_test_1.test)('returns false for null expected', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('provided', null), false);
    });
    (0, node_test_1.test)('returns false for different-length strings', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('short', 'muchlongerstring'), false);
    });
    (0, node_test_1.test)('returns false when both are empty', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)('', ''), false);
    });
    (0, node_test_1.test)('does not trim or normalize secrets', () => {
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(' secret ', ' secret '), true);
        strict_1.default.equal((0, secret_compare_1.safeSecretEqual)(' secret ', 'secret'), false);
    });
});
(0, node_test_1.describe)('matchesAnySecret', () => {
    (0, node_test_1.test)('matches first candidate', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('key-a', ['key-a', 'key-b']), true);
    });
    (0, node_test_1.test)('matches second candidate', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('key-b', ['key-a', 'key-b']), true);
    });
    (0, node_test_1.test)('matches legacy fallback', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('legacy-key', [undefined, 'legacy-key']), true);
    });
    (0, node_test_1.test)('matches new key when both present', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('new-key', ['new-key', 'old-key']), true);
    });
    (0, node_test_1.test)('matches legacy key when both present', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('old-key', ['new-key', 'old-key']), true);
    });
    (0, node_test_1.test)('rejects key from different trust boundary', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('bridge-key', ['gaming-key', undefined]), false);
    });
    (0, node_test_1.test)('rejects empty provided', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('', ['key-a', 'key-b']), false);
    });
    (0, node_test_1.test)('rejects when no candidates provided', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('key-a', []), false);
    });
    (0, node_test_1.test)('rejects when all candidates are undefined/null', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('key-a', [undefined, null]), false);
    });
    (0, node_test_1.test)('rejects wrong key', () => {
        strict_1.default.equal((0, secret_compare_1.matchesAnySecret)('wrong-key', ['correct-key']), false);
    });
});
//# sourceMappingURL=secret-compare.test.js.map