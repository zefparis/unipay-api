import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const readSrc = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), 'utf-8');

// ─── SS1: Secret separation (ADMIN_SECRET vs CRON_SERVICE_SECRET) ──

describe('SS1 — ADMIN_SECRET and CRON_SERVICE_SECRET are separate', () => {
  const HMAC = readSrc('src/plugins/hmac.ts');
  const ENV = readSrc('src/config/env.ts');
  const ENV_EXAMPLE = readSrc('.env.example');
  const CRON_PULL = readSrc('scripts/cron-pull-dev-expenses.js');
  const CRON_DUE = readSrc('scripts/cron-due-date-check.js');
  const RENDER = readSrc('render.yaml');

  it('env.ts defines CRON_SERVICE_SECRET', () => {
    assert.match(ENV, /CRON_SERVICE_SECRET/i);
  });

  it('env.ts documents the independence from ADMIN_SECRET', () => {
    // The comment around CRON_SERVICE_SECRET should mention separation/independence
    const envContent = ENV;
    assert.match(
      envContent,
      /Separate from ADMIN_SECRET|Independent from CRON_SERVICE_SECRET/i,
      'env.ts should document that the two secrets are independent',
    );
  });

  it('hmac.ts imports matchesAnySecret (not just safeSecretEqual)', () => {
    assert.match(HMAC, /matchesAnySecret/i);
  });

  it('hmac.ts checks both ADMIN_SECRET and CRON_SERVICE_SECRET', () => {
    assert.match(HMAC, /env\.ADMIN_SECRET/i);
    assert.match(HMAC, /env\.CRON_SERVICE_SECRET/i);
    assert.match(
      HMAC,
      /matchesAnySecret\(adminSecretHeader, \[env\.ADMIN_SECRET, env\.CRON_SERVICE_SECRET\]\)/i,
    );
  });

  it('cron-pull-dev-expenses.js uses CRON_SERVICE_SECRET (not ADMIN_SECRET directly)', () => {
    assert.match(CRON_PULL, /CRON_SERVICE_SECRET/i);
    // The fallback to ADMIN_SECRET is acceptable for backward compat
    // but the primary variable must be CRON_SERVICE_SECRET
    assert.match(CRON_PULL, /process\.env\.CRON_SERVICE_SECRET/i);
  });

  it('cron-due-date-check.js uses CRON_SERVICE_SECRET (not ADMIN_SECRET directly)', () => {
    assert.match(CRON_DUE, /CRON_SERVICE_SECRET/i);
    assert.match(CRON_DUE, /process\.env\.CRON_SERVICE_SECRET/i);
  });

  it('render.yaml cron services use CRON_SERVICE_SECRET', () => {
    assert.match(RENDER, /key: CRON_SERVICE_SECRET/i);
    // Should NOT have ADMIN_SECRET in cron envVars anymore
    const cronSections = RENDER.split(/type: cron/);
    for (let i = 1; i < cronSections.length; i++) {
      const section = cronSections[i];
      // Each cron section should have CRON_SERVICE_SECRET, not ADMIN_SECRET
      assert.match(section, /CRON_SERVICE_SECRET/i, `cron section ${i} should use CRON_SERVICE_SECRET`);
      assert.doesNotMatch(section, /key: ADMIN_SECRET/i, `cron section ${i} should NOT use ADMIN_SECRET`);
    }
  });

  it('.env.example documents both secrets with distinct comments', () => {
    assert.match(ENV_EXAMPLE, /ADMIN_SECRET/i);
    assert.match(ENV_EXAMPLE, /CRON_SERVICE_SECRET/i);
    assert.match(ENV_EXAMPLE, /interactive admin dashboard/i);
    assert.match(ENV_EXAMPLE, /cron.*separate|separate.*cron/i);
  });

  it('wallet/internal.ts accepts both secrets', () => {
    const INTERNAL = readSrc('src/routes/wallet/internal.ts');
    assert.match(INTERNAL, /ADMIN_SECRET/i);
    assert.match(INTERNAL, /CRON_SERVICE_SECRET/i);
  });
});

// ─── SS2: Dead code removed ───────────────────────────────────────

describe('SS2 — dead code and legacy page removed', () => {
  const HMAC = readSrc('src/plugins/hmac.ts');

  it('hmac.ts does NOT contain ADMIN_EMAILS check', () => {
    assert.doesNotMatch(HMAC, /ADMIN_EMAILS/i);
  });

  it('hmac.ts does NOT contain the dead "admin via API key" block', () => {
    assert.doesNotMatch(HMAC, /If admin via API key, verify email is in allowed list/i);
  });

  it('legacy-auth route.ts is deleted', () => {
    const legacyPath = path.resolve(ROOT, '../unipay-congo/app/api/admin/legacy-auth/route.ts');
    assert.ok(!fs.existsSync(legacyPath), 'legacy-auth/route.ts should not exist');
  });

  it('legacy /admin page.tsx is deleted', () => {
    const adminPagePath = path.resolve(ROOT, '../unipay-congo/app/[locale]/admin/page.tsx');
    assert.ok(!fs.existsSync(adminPagePath), 'admin/page.tsx should not exist');
  });

  it('NEXT_PUBLIC_ADMIN_PASSWORD is not referenced anywhere in unipay-congo source', () => {
    const congoRoot = path.resolve(ROOT, '../unipay-congo');
    const result = require('child_process').execSync(
      `grep -r "NEXT_PUBLIC_ADMIN_PASSWORD" --include="*.ts" --include="*.tsx" --include="*.js" --exclude-dir=.next --exclude-dir=node_modules "${congoRoot}" 2>/dev/null || true`,
    ).toString();
    assert.equal(result.trim(), '', 'NEXT_PUBLIC_ADMIN_PASSWORD should not be referenced in source files');
  });
});

// ─── SS3: Admin action log — migration ─────────────────────────────

describe('SS3 — admin_action_log migration', () => {
  const MIGRATION = readSrc('supabase/migrations/20260911000000_admin_action_log.sql');

  it('creates admin_action_log table', () => {
    assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.admin_action_log/i);
  });

  it('has action, resource_type, resource_id, request_summary, actor, created_at columns', () => {
    assert.match(MIGRATION, /action\s+text/i);
    assert.match(MIGRATION, /resource_type\s+text/i);
    assert.match(MIGRATION, /resource_id\s+uuid/i);
    assert.match(MIGRATION, /request_summary\s+jsonb/i);
    assert.match(MIGRATION, /actor\s+text/i);
    assert.match(MIGRATION, /created_at\s+timestamptz/i);
  });

  it('enables RLS', () => {
    assert.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/i);
  });

  it('has indexes on created_at, action, and resource', () => {
    assert.match(MIGRATION, /idx_admin_action_log_created_at/i);
    assert.match(MIGRATION, /idx_admin_action_log_action/i);
    assert.match(MIGRATION, /idx_admin_action_log_resource/i);
  });

  it('actor defaults to admin', () => {
    assert.match(MIGRATION, /DEFAULT 'admin'/i);
  });
});

// ─── SS4: logAdminAction helper ────────────────────────────────────

describe('SS4 — logAdminAction helper', () => {
  const HELPER = readSrc('src/lib/admin-action-log.ts');

  it('exports logAdminAction function', () => {
    assert.match(HELPER, /export async function logAdminAction/i);
  });

  it('inserts into admin_action_log table', () => {
    assert.match(HELPER, /from\('admin_action_log'\)/i);
    assert.match(HELPER, /\.insert\(/i);
  });

  it('is fire-and-forget (does not throw on failure)', () => {
    // The function catches errors and logs them, but does not re-throw
    assert.match(HELPER, /catch\s*\(err\)/i);
    assert.doesNotMatch(HELPER, /throw/i);
  });

  it('sets actor to admin', () => {
    assert.match(HELPER, /actor:\s*'admin'/i);
  });

  it('accepts action, resourceType, resourceId, requestSummary, log params', () => {
    assert.match(HELPER, /action:\s*string/i);
    assert.match(HELPER, /resourceType:\s*string/i);
    assert.match(HELPER, /resourceId:\s*string\s*\|\s*null\s*\|\s*undefined/i);
    assert.match(HELPER, /requestSummary:\s*Record/i);
  });
});

// ─── SS5: Sensitive routes are instrumented ────────────────────────

describe('SS5 — sensitive admin routes log actions', () => {
  const MERCHANTS = readSrc('src/routes/admin/merchants.ts');
  const WALLET = readSrc('src/routes/admin/wallet.ts');
  const SETTLEMENTS = readSrc('src/routes/admin/settlements.ts');

  it('merchants.ts imports logAdminAction', () => {
    assert.match(MERCHANTS, /logAdminAction/i);
  });

  it('merchants.ts logs merchant.suspend', () => {
    assert.match(MERCHANTS, /'merchant\.suspend'/i);
  });

  it('merchants.ts logs merchant.reactivate', () => {
    assert.match(MERCHANTS, /'merchant\.reactivate'/i);
  });

  it('merchants.ts logs merchant.kyc_approve', () => {
    assert.match(MERCHANTS, /'merchant\.kyc_approve'/i);
  });

  it('merchants.ts logs merchant.kyc_reject', () => {
    assert.match(MERCHANTS, /'merchant\.kyc_reject'/i);
  });

  it('merchants.ts logs merchant.api_key_revoke', () => {
    assert.match(MERCHANTS, /'merchant\.api_key_revoke'/i);
  });

  it('merchants.ts logs merchant.api_key_regenerate', () => {
    assert.match(MERCHANTS, /'merchant\.api_key_regenerate'/i);
  });

  it('wallet.ts imports logAdminAction', () => {
    assert.match(WALLET, /logAdminAction/i);
  });

  it('wallet.ts logs wallet_user.block', () => {
    assert.match(WALLET, /'wallet_user\.block'/i);
  });

  it('wallet.ts logs wallet_user.unblock', () => {
    assert.match(WALLET, /'wallet_user\.unblock'/i);
  });

  it('wallet.ts logs wallet_user.kyc_approve', () => {
    assert.match(WALLET, /'wallet_user\.kyc_approve'/i);
  });

  it('wallet.ts logs wallet_user.balance_adjust', () => {
    assert.match(WALLET, /'wallet_user\.balance_adjust'/i);
  });

  it('wallet.ts logs wallet_kyc.approve', () => {
    assert.match(WALLET, /'wallet_kyc\.approve'/i);
  });

  it('settlements.ts imports logAdminAction', () => {
    assert.match(SETTLEMENTS, /logAdminAction/i);
  });

  it('settlements.ts logs settlement.approve', () => {
    assert.match(SETTLEMENTS, /'settlement\.approve'/i);
  });

  it('settlements.ts logs settlement.reject', () => {
    assert.match(SETTLEMENTS, /'settlement\.reject'/i);
  });

  it('logAdminAction calls are non-blocking (void prefix)', () => {
    // All calls should use void to make them fire-and-forget
    const allRoutes = MERCHANTS + WALLET + SETTLEMENTS;
    const calls = allRoutes.match(/void logAdminAction/g) ?? [];
    assert.ok(calls.length >= 10, `expected at least 10 void logAdminAction calls, found ${calls.length}`);
    // No non-void calls (await logAdminAction would block)
    const blockingCalls = allRoutes.match(/(?<!void )await logAdminAction/g) ?? [];
    assert.equal(blockingCalls.length, 0, 'logAdminAction should not be awaited (fire-and-forget)');
  });
});

// ─── SS6: Action log route ─────────────────────────────────────────

describe('SS6 — GET /v1/admin/action-log route', () => {
  const ROUTE = readSrc('src/routes/admin/action-log.ts');
  const SERVER = readSrc('src/server.ts');

  it('route file exists and exports default', () => {
    assert.match(ROUTE, /export default actionLogRoute/i);
  });

  it('requires admin', () => {
    assert.match(ROUTE, /requireAdmin\(request\.isAdmin\)/i);
  });

  it('supports pagination', () => {
    assert.match(ROUTE, /page/i);
    assert.match(ROUTE, /limit/i);
    assert.match(ROUTE, /range\(offset/i);
  });

  it('supports filtering by action, resource_type, resource_id, from, to', () => {
    assert.match(ROUTE, /\.eq\('action'/i);
    assert.match(ROUTE, /\.eq\('resource_type'/i);
    assert.match(ROUTE, /\.eq\('resource_id'/i);
    assert.match(ROUTE, /\.gte\('created_at', from\)/i);
    assert.match(ROUTE, /\.lte\('created_at', to\)/i);
  });

  it('orders by created_at descending', () => {
    assert.match(ROUTE, /order\('created_at', \{ ascending: false \}\)/i);
  });

  it('is registered in server.ts', () => {
    assert.match(SERVER, /import adminActionLogRoute/i);
    assert.match(SERVER, /register\(adminActionLogRoute\)/i);
  });
});
