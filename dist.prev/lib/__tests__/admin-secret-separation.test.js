"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const readSrc = (rel) => node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, rel), 'utf-8');
// ─── SS1: Secret separation (ADMIN_SECRET vs CRON_SERVICE_SECRET) ──
(0, node_test_1.describe)('SS1 — ADMIN_SECRET and CRON_SERVICE_SECRET are separate', () => {
    const HMAC = readSrc('src/plugins/hmac.ts');
    const ENV = readSrc('src/config/env.ts');
    const ENV_EXAMPLE = readSrc('.env.example');
    const CRON_PULL = readSrc('scripts/cron-pull-dev-expenses.js');
    const CRON_DUE = readSrc('scripts/cron-due-date-check.js');
    const RENDER = readSrc('render.yaml');
    (0, node_test_1.it)('env.ts defines CRON_SERVICE_SECRET', () => {
        strict_1.default.match(ENV, /CRON_SERVICE_SECRET/i);
    });
    (0, node_test_1.it)('env.ts documents the independence from ADMIN_SECRET', () => {
        // The comment around CRON_SERVICE_SECRET should mention separation/independence
        const envContent = ENV;
        strict_1.default.match(envContent, /Separate from ADMIN_SECRET|Independent from CRON_SERVICE_SECRET/i, 'env.ts should document that the two secrets are independent');
    });
    (0, node_test_1.it)('hmac.ts imports matchesAnySecret (not just safeSecretEqual)', () => {
        strict_1.default.match(HMAC, /matchesAnySecret/i);
    });
    (0, node_test_1.it)('hmac.ts checks both ADMIN_SECRET and CRON_SERVICE_SECRET', () => {
        strict_1.default.match(HMAC, /env\.ADMIN_SECRET/i);
        strict_1.default.match(HMAC, /env\.CRON_SERVICE_SECRET/i);
        strict_1.default.match(HMAC, /matchesAnySecret\(adminSecretHeader, \[env\.ADMIN_SECRET, env\.CRON_SERVICE_SECRET\]\)/i);
    });
    (0, node_test_1.it)('cron-pull-dev-expenses.js uses CRON_SERVICE_SECRET (not ADMIN_SECRET directly)', () => {
        strict_1.default.match(CRON_PULL, /CRON_SERVICE_SECRET/i);
        // The fallback to ADMIN_SECRET is acceptable for backward compat
        // but the primary variable must be CRON_SERVICE_SECRET
        strict_1.default.match(CRON_PULL, /process\.env\.CRON_SERVICE_SECRET/i);
    });
    (0, node_test_1.it)('cron-due-date-check.js uses CRON_SERVICE_SECRET (not ADMIN_SECRET directly)', () => {
        strict_1.default.match(CRON_DUE, /CRON_SERVICE_SECRET/i);
        strict_1.default.match(CRON_DUE, /process\.env\.CRON_SERVICE_SECRET/i);
    });
    (0, node_test_1.it)('render.yaml cron services use CRON_SERVICE_SECRET', () => {
        strict_1.default.match(RENDER, /key: CRON_SERVICE_SECRET/i);
        // Should NOT have ADMIN_SECRET in cron envVars anymore
        const cronSections = RENDER.split(/type: cron/);
        for (let i = 1; i < cronSections.length; i++) {
            const section = cronSections[i];
            // Each cron section should have CRON_SERVICE_SECRET, not ADMIN_SECRET
            strict_1.default.match(section, /CRON_SERVICE_SECRET/i, `cron section ${i} should use CRON_SERVICE_SECRET`);
            strict_1.default.doesNotMatch(section, /key: ADMIN_SECRET/i, `cron section ${i} should NOT use ADMIN_SECRET`);
        }
    });
    (0, node_test_1.it)('.env.example documents both secrets with distinct comments', () => {
        strict_1.default.match(ENV_EXAMPLE, /ADMIN_SECRET/i);
        strict_1.default.match(ENV_EXAMPLE, /CRON_SERVICE_SECRET/i);
        strict_1.default.match(ENV_EXAMPLE, /interactive admin dashboard/i);
        strict_1.default.match(ENV_EXAMPLE, /cron.*separate|separate.*cron/i);
    });
    (0, node_test_1.it)('wallet/internal.ts accepts both secrets', () => {
        const INTERNAL = readSrc('src/routes/wallet/internal.ts');
        strict_1.default.match(INTERNAL, /ADMIN_SECRET/i);
        strict_1.default.match(INTERNAL, /CRON_SERVICE_SECRET/i);
    });
});
// ─── SS2: Dead code removed ───────────────────────────────────────
(0, node_test_1.describe)('SS2 — dead code and legacy page removed', () => {
    const HMAC = readSrc('src/plugins/hmac.ts');
    (0, node_test_1.it)('hmac.ts does NOT contain ADMIN_EMAILS check', () => {
        strict_1.default.doesNotMatch(HMAC, /ADMIN_EMAILS/i);
    });
    (0, node_test_1.it)('hmac.ts does NOT contain the dead "admin via API key" block', () => {
        strict_1.default.doesNotMatch(HMAC, /If admin via API key, verify email is in allowed list/i);
    });
    (0, node_test_1.it)('legacy-auth route.ts is deleted', () => {
        const legacyPath = node_path_1.default.resolve(ROOT, '../unipay-congo/app/api/admin/legacy-auth/route.ts');
        strict_1.default.ok(!node_fs_1.default.existsSync(legacyPath), 'legacy-auth/route.ts should not exist');
    });
    (0, node_test_1.it)('legacy /admin page.tsx is deleted', () => {
        const adminPagePath = node_path_1.default.resolve(ROOT, '../unipay-congo/app/[locale]/admin/page.tsx');
        strict_1.default.ok(!node_fs_1.default.existsSync(adminPagePath), 'admin/page.tsx should not exist');
    });
    (0, node_test_1.it)('NEXT_PUBLIC_ADMIN_PASSWORD is not referenced anywhere in unipay-congo source', () => {
        const congoRoot = node_path_1.default.resolve(ROOT, '../unipay-congo');
        const result = require('child_process').execSync(`grep -r "NEXT_PUBLIC_ADMIN_PASSWORD" --include="*.ts" --include="*.tsx" --include="*.js" --exclude-dir=.next --exclude-dir=node_modules "${congoRoot}" 2>/dev/null || true`).toString();
        strict_1.default.equal(result.trim(), '', 'NEXT_PUBLIC_ADMIN_PASSWORD should not be referenced in source files');
    });
});
// ─── SS3: Admin action log — migration ─────────────────────────────
(0, node_test_1.describe)('SS3 — admin_action_log migration', () => {
    const MIGRATION = readSrc('supabase/migrations/20260911000000_admin_action_log.sql');
    (0, node_test_1.it)('creates admin_action_log table', () => {
        strict_1.default.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.admin_action_log/i);
    });
    (0, node_test_1.it)('has action, resource_type, resource_id, request_summary, actor, created_at columns', () => {
        strict_1.default.match(MIGRATION, /action\s+text/i);
        strict_1.default.match(MIGRATION, /resource_type\s+text/i);
        strict_1.default.match(MIGRATION, /resource_id\s+uuid/i);
        strict_1.default.match(MIGRATION, /request_summary\s+jsonb/i);
        strict_1.default.match(MIGRATION, /actor\s+text/i);
        strict_1.default.match(MIGRATION, /created_at\s+timestamptz/i);
    });
    (0, node_test_1.it)('enables RLS', () => {
        strict_1.default.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/i);
    });
    (0, node_test_1.it)('has indexes on created_at, action, and resource', () => {
        strict_1.default.match(MIGRATION, /idx_admin_action_log_created_at/i);
        strict_1.default.match(MIGRATION, /idx_admin_action_log_action/i);
        strict_1.default.match(MIGRATION, /idx_admin_action_log_resource/i);
    });
    (0, node_test_1.it)('actor defaults to admin', () => {
        strict_1.default.match(MIGRATION, /DEFAULT 'admin'/i);
    });
});
// ─── SS4: logAdminAction helper ────────────────────────────────────
(0, node_test_1.describe)('SS4 — logAdminAction helper', () => {
    const HELPER = readSrc('src/lib/admin-action-log.ts');
    (0, node_test_1.it)('exports logAdminAction function', () => {
        strict_1.default.match(HELPER, /export async function logAdminAction/i);
    });
    (0, node_test_1.it)('inserts into admin_action_log table', () => {
        strict_1.default.match(HELPER, /from\('admin_action_log'\)/i);
        strict_1.default.match(HELPER, /\.insert\(/i);
    });
    (0, node_test_1.it)('is fire-and-forget (does not throw on failure)', () => {
        // The function catches errors and logs them, but does not re-throw
        strict_1.default.match(HELPER, /catch\s*\(err\)/i);
        strict_1.default.doesNotMatch(HELPER, /throw/i);
    });
    (0, node_test_1.it)('sets actor to admin', () => {
        strict_1.default.match(HELPER, /actor:\s*'admin'/i);
    });
    (0, node_test_1.it)('accepts action, resourceType, resourceId, requestSummary, log params', () => {
        strict_1.default.match(HELPER, /action:\s*string/i);
        strict_1.default.match(HELPER, /resourceType:\s*string/i);
        strict_1.default.match(HELPER, /resourceId:\s*string\s*\|\s*null\s*\|\s*undefined/i);
        strict_1.default.match(HELPER, /requestSummary:\s*Record/i);
    });
});
// ─── SS5: Sensitive routes are instrumented ────────────────────────
(0, node_test_1.describe)('SS5 — sensitive admin routes log actions', () => {
    const MERCHANTS = readSrc('src/routes/admin/merchants.ts');
    const WALLET = readSrc('src/routes/admin/wallet.ts');
    const SETTLEMENTS = readSrc('src/routes/admin/settlements.ts');
    (0, node_test_1.it)('merchants.ts imports logAdminAction', () => {
        strict_1.default.match(MERCHANTS, /logAdminAction/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.suspend', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.suspend'/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.reactivate', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.reactivate'/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.kyc_approve', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.kyc_approve'/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.kyc_reject', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.kyc_reject'/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.api_key_revoke', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.api_key_revoke'/i);
    });
    (0, node_test_1.it)('merchants.ts logs merchant.api_key_regenerate', () => {
        strict_1.default.match(MERCHANTS, /'merchant\.api_key_regenerate'/i);
    });
    (0, node_test_1.it)('wallet.ts imports logAdminAction', () => {
        strict_1.default.match(WALLET, /logAdminAction/i);
    });
    (0, node_test_1.it)('wallet.ts logs wallet_user.block', () => {
        strict_1.default.match(WALLET, /'wallet_user\.block'/i);
    });
    (0, node_test_1.it)('wallet.ts logs wallet_user.unblock', () => {
        strict_1.default.match(WALLET, /'wallet_user\.unblock'/i);
    });
    (0, node_test_1.it)('wallet.ts logs wallet_user.kyc_approve', () => {
        strict_1.default.match(WALLET, /'wallet_user\.kyc_approve'/i);
    });
    (0, node_test_1.it)('wallet.ts logs wallet_user.balance_adjust', () => {
        strict_1.default.match(WALLET, /'wallet_user\.balance_adjust'/i);
    });
    (0, node_test_1.it)('wallet.ts logs wallet_kyc.approve', () => {
        strict_1.default.match(WALLET, /'wallet_kyc\.approve'/i);
    });
    (0, node_test_1.it)('settlements.ts imports logAdminAction', () => {
        strict_1.default.match(SETTLEMENTS, /logAdminAction/i);
    });
    (0, node_test_1.it)('settlements.ts logs settlement.approve', () => {
        strict_1.default.match(SETTLEMENTS, /'settlement\.approve'/i);
    });
    (0, node_test_1.it)('settlements.ts logs settlement.reject', () => {
        strict_1.default.match(SETTLEMENTS, /'settlement\.reject'/i);
    });
    (0, node_test_1.it)('logAdminAction calls are non-blocking (void prefix)', () => {
        // All calls should use void to make them fire-and-forget
        const allRoutes = MERCHANTS + WALLET + SETTLEMENTS;
        const calls = allRoutes.match(/void logAdminAction/g) ?? [];
        strict_1.default.ok(calls.length >= 10, `expected at least 10 void logAdminAction calls, found ${calls.length}`);
        // No non-void calls (await logAdminAction would block)
        const blockingCalls = allRoutes.match(/(?<!void )await logAdminAction/g) ?? [];
        strict_1.default.equal(blockingCalls.length, 0, 'logAdminAction should not be awaited (fire-and-forget)');
    });
});
// ─── SS6: Action log route ─────────────────────────────────────────
(0, node_test_1.describe)('SS6 — GET /v1/admin/action-log route', () => {
    const ROUTE = readSrc('src/routes/admin/action-log.ts');
    const SERVER = readSrc('src/server.ts');
    (0, node_test_1.it)('route file exists and exports default', () => {
        strict_1.default.match(ROUTE, /export default actionLogRoute/i);
    });
    (0, node_test_1.it)('requires admin', () => {
        strict_1.default.match(ROUTE, /requireAdmin\(request\.isAdmin\)/i);
    });
    (0, node_test_1.it)('supports pagination', () => {
        strict_1.default.match(ROUTE, /page/i);
        strict_1.default.match(ROUTE, /limit/i);
        strict_1.default.match(ROUTE, /range\(offset/i);
    });
    (0, node_test_1.it)('supports filtering by action, resource_type, resource_id, from, to', () => {
        strict_1.default.match(ROUTE, /\.eq\('action'/i);
        strict_1.default.match(ROUTE, /\.eq\('resource_type'/i);
        strict_1.default.match(ROUTE, /\.eq\('resource_id'/i);
        strict_1.default.match(ROUTE, /\.gte\('created_at', from\)/i);
        strict_1.default.match(ROUTE, /\.lte\('created_at', to\)/i);
    });
    (0, node_test_1.it)('orders by created_at descending', () => {
        strict_1.default.match(ROUTE, /order\('created_at', \{ ascending: false \}\)/i);
    });
    (0, node_test_1.it)('is registered in server.ts', () => {
        strict_1.default.match(SERVER, /import adminActionLogRoute/i);
        strict_1.default.match(SERVER, /register\(adminActionLogRoute\)/i);
    });
});
//# sourceMappingURL=admin-secret-separation.test.js.map