"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * M8 remediation tests — account enumeration prevention.
 *
 * Two combined flaws allowed determining if an email/phone corresponds
 * to an existing account:
 *   1. Different error messages: 403 "Account is not active" (exists
 *      but inactive) vs 401 "Invalid credentials" (doesn't exist or
 *      wrong password)
 *   2. Timing oracle: bcrypt.compare only ran if the account existed
 *
 * Fix:
 *   - Uniform 401 "Invalid credentials" in ALL failure cases
 *   - bcrypt.compare always runs (against DUMMY_HASH if account
 *     doesn't exist) to eliminate the timing oracle
 *   - Real reason logged server-side (reason: 'account_not_found' |
 *     'inactive_account' | 'invalid_password')
 *
 * Tests verify both merchant login and wallet login.
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const MERCHANT_LOGIN = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/merchant/login.ts'), 'utf-8');
const WALLET_AUTH = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/auth.ts'), 'utf-8');
// ── Merchant login tests ────────────────────────────────────
(0, node_test_1.describe)('M8-merchant — uniform 401 + constant-time', () => {
    (0, node_test_1.it)('defines DUMMY_HASH for constant-time comparison', () => {
        strict_1.default.match(MERCHANT_LOGIN, /DUMMY_HASH/);
        strict_1.default.match(MERCHANT_LOGIN, /\$2a\$10\$/);
    });
    (0, node_test_1.it)('always runs bcrypt.compare (even if account does not exist)', () => {
        // The code should compute hashToCompare = accountExists ? real_hash : DUMMY_HASH
        // and then always call bcrypt.compare
        strict_1.default.match(MERCHANT_LOGIN, /hashToCompare\s*=\s*accountExists/);
        strict_1.default.match(MERCHANT_LOGIN, /DUMMY_HASH/);
        strict_1.default.match(MERCHANT_LOGIN, /bcrypt\.compare\(password,\s*hashToCompare\)/);
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for account_not_found', () => {
        strict_1.default.match(MERCHANT_LOGIN, /account_not_found/);
        strict_1.default.match(MERCHANT_LOGIN, /reason:\s*'account_not_found'/);
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for inactive_account (NOT 403)', () => {
        strict_1.default.match(MERCHANT_LOGIN, /reason:\s*'inactive_account'/);
        // Should NOT return 403 for inactive accounts anymore
        // Find the inactive_account block and verify it returns 401
        const inactiveMatch = MERCHANT_LOGIN.match(/inactive_account[\s\S]*?return reply\.status\((\d+)\)/);
        strict_1.default.ok(inactiveMatch, 'must find inactive_account return');
        strict_1.default.strictEqual(inactiveMatch[1], '401', 'inactive_account must return 401, not 403');
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for invalid_password', () => {
        strict_1.default.match(MERCHANT_LOGIN, /reason:\s*'invalid_password'/);
    });
    (0, node_test_1.it)('does NOT return 403 "Account is not active" anymore', () => {
        // Strip comments before checking
        const stripped = MERCHANT_LOGIN
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        strict_1.default.doesNotMatch(stripped, /'Account is not active'/);
    });
    (0, node_test_1.it)('logs the real reason server-side', () => {
        strict_1.default.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'account_not_found'/);
        strict_1.default.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'inactive_account'/);
        strict_1.default.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'invalid_password'/);
    });
});
// ── Wallet login tests ──────────────────────────────────────
(0, node_test_1.describe)('M8-wallet — uniform 401 + constant-time', () => {
    (0, node_test_1.it)('defines DUMMY_HASH for constant-time comparison', () => {
        strict_1.default.match(WALLET_AUTH, /DUMMY_HASH/);
        strict_1.default.match(WALLET_AUTH, /\$2a\$10\$/);
    });
    (0, node_test_1.it)('always runs bcrypt.compare (even if account does not exist)', () => {
        strict_1.default.match(WALLET_AUTH, /hashToCompare\s*=\s*accountExists/);
        strict_1.default.match(WALLET_AUTH, /bcrypt\.compare\(pin,\s*hashToCompare\)/);
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for account_not_found', () => {
        strict_1.default.match(WALLET_AUTH, /reason:\s*'account_not_found'/);
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for inactive_account (NOT 403)', () => {
        strict_1.default.match(WALLET_AUTH, /reason:\s*'inactive_account'/);
        // Find the inactive_account block and verify it returns 401
        const inactiveMatch = WALLET_AUTH.match(/inactive_account[\s\S]*?return reply\.status\((\d+)\)/);
        strict_1.default.ok(inactiveMatch, 'must find inactive_account return');
        strict_1.default.strictEqual(inactiveMatch[1], '401', 'inactive_account must return 401, not 403');
    });
    (0, node_test_1.it)('returns 401 "Invalid credentials" for invalid_pin', () => {
        strict_1.default.match(WALLET_AUTH, /reason:\s*'invalid_pin'/);
    });
    (0, node_test_1.it)('does NOT return 403 "Account is suspended" anymore', () => {
        // Strip comments before checking
        const stripped = WALLET_AUTH
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        strict_1.default.doesNotMatch(stripped, /'Account is suspended'/);
    });
    (0, node_test_1.it)('logs the real reason server-side', () => {
        strict_1.default.match(WALLET_AUTH, /fastify\.log\.info\([\s\S]*?reason:\s*'account_not_found'/);
        strict_1.default.match(WALLET_AUTH, /fastify\.log\.info\([\s\S]*?reason:\s*'inactive_account'/);
        strict_1.default.match(WALLET_AUTH, /reason:\s*'invalid_pin'/);
    });
    (0, node_test_1.it)('preserves lockout check (423) for too many failed PIN attempts', () => {
        // The lockout check should still return 423 — it's a separate
        // concern from account enumeration
        strict_1.default.match(WALLET_AUTH, /423/);
        strict_1.default.match(WALLET_AUTH, /locked/);
    });
});
//# sourceMappingURL=m8-account-enumeration.test.js.map