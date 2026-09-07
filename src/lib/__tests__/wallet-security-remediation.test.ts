import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROUTES_DIR = path.resolve(__dirname, '../../routes');
const LIB_DIR    = path.resolve(__dirname, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(ROUTES_DIR, rel), 'utf-8');
}

// ─── W1: wallet-auth.ts helper ──────────────────────────────────

describe('W1 — wallet-auth.ts exports requireActiveWallet', () => {
  const WALLET_AUTH = fs.readFileSync(
    path.resolve(LIB_DIR, 'wallet-auth.ts'),
    'utf-8',
  );

  it('exports requireActiveWallet function', () => {
    assert.match(
      WALLET_AUTH,
      /export async function requireActiveWallet/,
      'must export requireActiveWallet',
    );
  });

  it('checks wallet_users.is_active and returns 403 if false', () => {
    assert.match(
      WALLET_AUTH,
      /is_active/,
      'must check is_active field',
    );
    assert.match(
      WALLET_AUTH,
      /Account is suspended/,
      'must return "Account is suspended" error message',
    );
    assert.match(
      WALLET_AUTH,
      /status: 403/,
      'must return 403 status for suspended wallet',
    );
  });

  it('returns 401 for missing/invalid JWT', () => {
    assert.match(
      WALLET_AUTH,
      /status: 401/,
      'must return 401 for unauthorized',
    );
  });

  it('returns 404 when wallet not found in DB', () => {
    assert.match(
      WALLET_AUTH,
      /status: 404/,
      'must return 404 for missing wallet',
    );
  });

  it('queries wallet_users table by wallet_id', () => {
    assert.match(
      WALLET_AUTH,
      /from\('wallet_users'\)/,
      'must query wallet_users table',
    );
    assert.match(
      WALLET_AUTH,
      /eq\('id', payload\.wallet_id\)/,
      'must filter by payload.wallet_id',
    );
  });

  it('exports walletIdFromRequest for rate-limit keyGenerator', () => {
    assert.match(
      WALLET_AUTH,
      /export function walletIdFromRequest/,
      'must export walletIdFromRequest',
    );
  });
});

// ─── W2: the 4 previously-unprotected routes ────────────────────

describe('W2 — 4 previously-unprotected routes now use requireActiveWallet', () => {
  it('wcglt-swap.ts uses requireActiveWallet (not requireWallet)', () => {
    const src = readSrc('wallet/wcglt-swap.ts');
    assert.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
    assert.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
    assert.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
  });

  it('crypto-deposit.ts uses requireActiveWallet (not requireWallet)', () => {
    const src = readSrc('wallet/crypto-deposit.ts');
    assert.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
    assert.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
    assert.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
  });

  it('stripe.ts uses requireActiveWallet (not requireWallet)', () => {
    const src = readSrc('wallet/stripe.ts');
    assert.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
    assert.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
    assert.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
  });

  it('transak.ts uses requireActiveWallet (not requireWallet)', () => {
    const src = readSrc('wallet/transak.ts');
    assert.match(src, /requireActiveWallet/, 'must import requireActiveWallet');
    assert.doesNotMatch(src, /from '.*wallet-jwt'/, 'must not import from wallet-jwt');
    assert.doesNotMatch(src, /requireWallet\(/, 'must not call requireWallet directly');
  });
});

// ─── W3: all other financial wallet routes use requireActiveWallet ──

describe('W3 — all financial wallet routes use requireActiveWallet', () => {
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
    it(`${route} uses requireActiveWallet`, () => {
      const src = readSrc(route);
      assert.match(
        src,
        /requireActiveWallet/,
        `${route} must import requireActiveWallet`,
      );
      assert.doesNotMatch(
        src,
        /requireWallet\(/,
        `${route} must not call requireWallet directly`,
      );
    });
  }
});

// ─── W4: no financial wallet route uses requireWallet directly ───

describe('W4 — no financial wallet route imports requireWallet directly', () => {
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
    it(`${file} does not import requireWallet from wallet-jwt`, () => {
      const src = readSrc(`wallet/${file}`);
      assert.doesNotMatch(
        src,
        /from '.*wallet-jwt'/,
        `${file} must not import from wallet-jwt (use wallet-auth instead)`,
      );
    });
  }
});

// ─── W5: financial write routes have rate limits ─────────────────

describe('W5 — financial write routes have rate limits', () => {
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
    it(`${route} has rateLimit config`, () => {
      const src = readSrc(route);
      assert.match(
        src,
        /rateLimit/,
        `${route} must have rateLimit config`,
      );
      assert.match(
        src,
        /walletIdFromRequest/,
        `${route} must use walletIdFromRequest as keyGenerator`,
      );
    });
  }
});

// ─── W6: unipesa.ts applies kyc_level limits ─────────────────────

describe('W6 — unipesa.ts applies kyc_level limits', () => {
  const src = readSrc('wallet/unipesa.ts');

  it('imports getLimits from kyc-limits', () => {
    assert.match(
      src,
      /from '.*kyc-limits'/,
      'must import getLimits from kyc-limits',
    );
  });

  it('deposit route checks deposit_daily limit', () => {
    assert.match(
      src,
      /limits\.deposit_daily/,
      'must check deposit_daily limit',
    );
    assert.match(
      src,
      /KYC_LIMIT_EXCEEDED/,
      'must return KYC_LIMIT_EXCEEDED error',
    );
  });

  it('withdraw route checks withdraw_daily limit', () => {
    assert.match(
      src,
      /limits\.withdraw_daily/,
      'must check withdraw_daily limit',
    );
  });

  it('both routes query today\'s transactions for daily usage', () => {
    const dailyUsageMatches = src.match(/dailyUsed/g);
    assert.ok(
      dailyUsageMatches && dailyUsageMatches.length >= 2,
      `expected ≥2 dailyUsed references (deposit + withdraw), got ${dailyUsageMatches?.length}`,
    );
  });
});

// ─── W7: RLS policy on withdrawal_requests ───────────────────────

describe('W7 — RLS policy on withdrawal_requests', () => {
  const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
  const files = fs.readdirSync(MIGRATIONS_DIR);
  const withdrawalPolicyFile = files.find(f =>
    f.includes('withdrawal_requests_rls') || f.includes('withdrawal_requests_policy'),
  );

  it('a migration adds service_role_all policy on withdrawal_requests', () => {
    assert.ok(
      withdrawalPolicyFile,
      'must have a migration file adding the RLS policy on withdrawal_requests',
    );
  });

  if (withdrawalPolicyFile) {
    const migrationSrc = fs.readFileSync(
      path.resolve(MIGRATIONS_DIR, withdrawalPolicyFile),
      'utf-8',
    );
    it('migration creates service_role_all policy', () => {
      assert.match(
        migrationSrc,
        /CREATE POLICY.*service_role_all.*ON withdrawal_requests/s,
        'must create service_role_all policy on withdrawal_requests',
      );
      assert.match(
        migrationSrc,
        /FOR ALL TO service_role/,
        'must be FOR ALL TO service_role',
      );
    });
  }
});
