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
 * Wallet route security remediation tests.
 *
 * Context: an audit revealed that 4 wallet routes had NO is_active check,
 * allowing a suspended user with a valid JWT to continue operating:
 *   - wcglt-swap.ts      (CGLT → wCGLT on-chain swap)
 *   - crypto-deposit.ts  (BSC deposit address + deposit list)
 *   - stripe.ts          (Stripe USD deposit intents)
 *   - transak.ts         (Transak fiat→USDT on-ramp)
 *
 * Additionally, every wallet route was doing inline requireWallet + manual
 * is_active checks instead of a shared helper (unlike the merchant side
 * which has requireActiveMerchant). This test file verifies:
 *
 *   W1 — wallet-auth.ts exports requireActiveWallet that checks is_active
 *   W2 — the 4 previously-unprotected routes now use requireActiveWallet
 *   W3 — all other financial wallet routes use requireActiveWallet
 *   W4 — no wallet route uses requireWallet directly anymore
 *   W5 — financial write routes have rate limits
 *   W6 — unipesa.ts applies kyc_level limits (was selecting but not enforcing)
 */
const ROUTES_DIR = node_path_1.default.resolve(__dirname, '../../routes');
const LIB_DIR = node_path_1.default.resolve(__dirname, '..');
function readSrc(rel) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(ROUTES_DIR, rel), 'utf-8');
}
// ─── W1: wallet-auth.ts helper ──────────────────────────────────
(0, node_test_1.describe)('W1 — wallet-auth.ts exports requireActiveWallet', () => {
    const WALLET_AUTH = node_fs_1.default.readFileSync(node_path_1.default.resolve(LIB_DIR, 'wallet-auth.ts'), 'utf-8');
    (0, node_test_1.it)('exports requireActiveWallet function', () => {
        strict_1.default.match(WALLET_AUTH, /export async function requireActiveWallet/, 'must export requireActiveWallet');
    });
    (0, node_test_1.it)('checks wallet_users.is_active and returns 403 if false', () => {
        strict_1.default.match(WALLET_AUTH, /is_active/, 'must check is_active field');
        strict_1.default.match(WALLET_AUTH, /Account is suspended/, 'must return "Account is suspended" error message');
        strict_1.default.match(WALLET_AUTH, /status: 403/, 'must return 403 status for suspended wallet');
    });
    (0, node_test_1.it)('returns 401 for missing/invalid JWT', () => {
        strict_1.default.match(WALLET_AUTH, /status: 401/, 'must return 401 for unauthorized');
    });
    (0, node_test_1.it)('returns 404 when wallet not found in DB', () => {
        strict_1.default.match(WALLET_AUTH, /status: 404/, 'must return 404 for missing wallet');
    });
    (0, node_test_1.it)('queries wallet_users table by wallet_id', () => {
        strict_1.default.match(WALLET_AUTH, /from\('wallet_users'\)/, 'must query wallet_users table');
        strict_1.default.match(WALLET_AUTH, /eq\('id', payload\.wallet_id\)/, 'must filter by payload.wallet_id');
    });
    (0, node_test_1.it)('exports walletIdFromRequest for rate-limit keyGenerator', () => {
        strict_1.default.match(WALLET_AUTH, /export function walletIdFromRequest/, 'must export walletIdFromRequest');
    });
});
// ─── W2: the 4 previously-unprotected routes ────────────────────
(0, node_test_1.describe)('W2 — 4 previously-unprotected routes now use requireActiveWallet', () => {
    (0, node_test_1.it)('wcglt-swap.ts uses requireActiveWallet (not requireWallet)', () => {
        const src = readSrc('wallet/wcglt-swap.ts');
        strict_1.default.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
        strict_1.default.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
        strict_1.default.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
    });
    (0, node_test_1.it)('crypto-deposit.ts uses requireActiveWallet (not requireWallet)', () => {
        const src = readSrc('wallet/crypto-deposit.ts');
        strict_1.default.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
        strict_1.default.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
        strict_1.default.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
    });
    (0, node_test_1.it)('stripe.ts uses requireActiveWallet (not requireWallet)', () => {
        const src = readSrc('wallet/stripe.ts');
        strict_1.default.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
        strict_1.default.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
        strict_1.default.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
    });
    (0, node_test_1.it)('transak.ts uses requireActiveWallet (not requireWallet)', () => {
        const src = readSrc('wallet/transak.ts');
        strict_1.default.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
        strict_1.default.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
        strict_1.default.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
    });
});
// ─── W3: all other financial wallet routes use requireActiveWallet ──
(0, node_test_1.describe)('W3 — all financial wallet routes use requireActiveWallet', () => {
    const FINANCIAL_ROUTES = [
        'wallet/deposit.ts',
        'wallet/withdraw.ts',
        'wallet/p2p.ts',
        'wallet/swap.ts',
        'wallet/unipesa.ts',
        'wallet/crypto-withdraw.ts',
        'wallet/cglt-gaming.ts',
        'wallet/kyc.ts',
    ];
    for (const route of FINANCIAL_ROUTES) {
        (0, node_test_1.it)(`${route} uses requireActiveWallet`, () => {
            const src = readSrc(route);
            strict_1.default.match(src, /requireActiveWallet/, `${route} must import requireActiveWallet`);
            strict_1.default.doesNotMatch(src, /requireWallet\(/, `${route} must not call requireWallet directly`);
        });
    }
});
// ─── W4: no financial wallet route uses requireWallet directly ───
(0, node_test_1.describe)('W4 — no financial wallet route imports requireWallet directly', () => {
    // Only financial routes are required to use requireActiveWallet.
    // Read-only routes (balance, notifications, profile, transactions) and
    // auth.ts (which issues the JWTs) are excluded from this requirement.
    const FINANCIAL_ROUTE_FILES = [
        'cglt-gaming.ts',
        'crypto-deposit.ts',
        'crypto-withdraw.ts',
        'deposit.ts',
        'kyc.ts',
        'p2p.ts',
        'stripe.ts',
        'swap.ts',
        'transak.ts',
        'unipesa.ts',
        'wcglt-swap.ts',
        'withdraw.ts',
    ];
    for (const file of FINANCIAL_ROUTE_FILES) {
        (0, node_test_1.it)(`${file} does not import requireWallet from wallet-jwt`, () => {
            const src = readSrc(`wallet/${file}`);
            strict_1.default.doesNotMatch(src, /from '.*wallet-jwt'/, `${file} must not import from wallet-jwt (use wallet-auth instead)`);
        });
    }
});
// ─── W5: financial write routes have rate limits ─────────────────
(0, node_test_1.describe)('W5 — financial write routes have rate limits', () => {
    const RATE_LIMITED_ROUTES = [
        'wallet/deposit.ts',
        'wallet/withdraw.ts',
        'wallet/p2p.ts',
        'wallet/swap.ts',
        'wallet/unipesa.ts',
        'wallet/crypto-withdraw.ts',
        'wallet/wcglt-swap.ts',
        'wallet/stripe.ts',
        'wallet/transak.ts',
    ];
    for (const route of RATE_LIMITED_ROUTES) {
        (0, node_test_1.it)(`${route} has rateLimit config`, () => {
            const src = readSrc(route);
            strict_1.default.match(src, /rateLimit/, `${route} must have rateLimit config`);
            strict_1.default.match(src, /walletIdFromRequest/, `${route} must use walletIdFromRequest as keyGenerator`);
        });
    }
});
// ─── W6: unipesa.ts applies kyc_level limits ─────────────────────
(0, node_test_1.describe)('W6 — unipesa.ts applies kyc_level limits', () => {
    const src = readSrc('wallet/unipesa.ts');
    (0, node_test_1.it)('imports getLimits from kyc-limits', () => {
        strict_1.default.match(src, /from '.*kyc-limits'/, 'must import getLimits from kyc-limits');
    });
    (0, node_test_1.it)('deposit route checks deposit_daily limit', () => {
        strict_1.default.match(src, /limits\.deposit_daily/, 'must check deposit_daily limit');
        strict_1.default.match(src, /KYC_LIMIT_EXCEEDED/, 'must return KYC_LIMIT_EXCEEDED error');
    });
    (0, node_test_1.it)('withdraw route checks withdraw_daily limit', () => {
        strict_1.default.match(src, /limits\.withdraw_daily/, 'must check withdraw_daily limit');
    });
    (0, node_test_1.it)('both routes query today\'s transactions for daily usage', () => {
        const dailyUsageMatches = src.match(/dailyUsed/g);
        strict_1.default.ok(dailyUsageMatches && dailyUsageMatches.length >= 2, `expected ≥2 dailyUsed references (deposit + withdraw), got ${dailyUsageMatches?.length}`);
    });
});
// ─── W7: RLS policy on withdrawal_requests ───────────────────────
(0, node_test_1.describe)('W7 — RLS policy on withdrawal_requests', () => {
    const MIGRATIONS_DIR = node_path_1.default.resolve(__dirname, '../../../supabase/migrations');
    const files = node_fs_1.default.readdirSync(MIGRATIONS_DIR);
    const withdrawalPolicyFile = files.find(f => f.includes('withdrawal_requests_rls') || f.includes('withdrawal_requests_policy'));
    (0, node_test_1.it)('a migration adds service_role_all policy on withdrawal_requests', () => {
        strict_1.default.ok(withdrawalPolicyFile, 'must have a migration file adding the RLS policy on withdrawal_requests');
    });
    if (withdrawalPolicyFile) {
        const migrationSrc = node_fs_1.default.readFileSync(node_path_1.default.resolve(MIGRATIONS_DIR, withdrawalPolicyFile), 'utf-8');
        (0, node_test_1.it)('migration creates service_role_all policy', () => {
            strict_1.default.match(migrationSrc, /CREATE POLICY.*service_role_all.*ON withdrawal_requests/s, 'must create service_role_all policy on withdrawal_requests');
            strict_1.default.match(migrationSrc, /FOR ALL TO service_role/, 'must be FOR ALL TO service_role');
        });
    }
});
//# sourceMappingURL=wallet-security-remediation.test.js.map