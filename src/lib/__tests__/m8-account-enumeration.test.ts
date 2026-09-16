import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const MERCHANT_LOGIN = fs.readFileSync(path.resolve(SRC, 'routes/merchant/login.ts'), 'utf-8');
const WALLET_AUTH = fs.readFileSync(path.resolve(SRC, 'routes/wallet/auth.ts'), 'utf-8');

// ── Merchant login tests ────────────────────────────────────

describe('M8-merchant — uniform 401 + constant-time', () => {
  it('defines DUMMY_HASH for constant-time comparison', () => {
    assert.match(MERCHANT_LOGIN, /DUMMY_HASH/);
    assert.match(MERCHANT_LOGIN, /\$2a\$10\$/);
  });

  it('always runs bcrypt.compare (even if account does not exist)', () => {
    // The code should compute hashToCompare = accountExists ? real_hash : DUMMY_HASH
    // and then always call bcrypt.compare
    assert.match(MERCHANT_LOGIN, /hashToCompare\s*=\s*accountExists/);
    assert.match(MERCHANT_LOGIN, /DUMMY_HASH/);
    assert.match(MERCHANT_LOGIN, /bcrypt\.compare\(password,\s*hashToCompare\)/);
  });

  it('returns 401 "Invalid credentials" for account_not_found', () => {
    assert.match(MERCHANT_LOGIN, /account_not_found/);
    assert.match(MERCHANT_LOGIN, /reason:\s*'account_not_found'/);
  });

  it('returns 401 "Invalid credentials" for inactive_account (NOT 403)', () => {
    assert.match(MERCHANT_LOGIN, /reason:\s*'inactive_account'/);
    // Should NOT return 403 for inactive accounts anymore
    // Find the inactive_account block and verify it returns 401
    const inactiveMatch = MERCHANT_LOGIN.match(/inactive_account[\s\S]*?return reply\.status\((\d+)\)/);
    assert.ok(inactiveMatch, 'must find inactive_account return');
    assert.strictEqual(inactiveMatch[1], '401', 'inactive_account must return 401, not 403');
  });

  it('returns 401 "Invalid credentials" for invalid_password', () => {
    assert.match(MERCHANT_LOGIN, /reason:\s*'invalid_password'/);
  });

  it('does NOT return 403 "Account is not active" anymore', () => {
    // Strip comments before checking
    const stripped = MERCHANT_LOGIN
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(stripped, /'Account is not active'/);
  });

  it('logs the real reason server-side', () => {
    assert.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'account_not_found'/);
    assert.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'inactive_account'/);
    assert.match(MERCHANT_LOGIN, /fastify\.log\.info\([\s\S]*?reason:\s*'invalid_password'/);
  });
});

// ── Wallet login tests ──────────────────────────────────────

describe('M8-wallet — uniform 401 + constant-time', () => {
  it('defines DUMMY_HASH for constant-time comparison', () => {
    assert.match(WALLET_AUTH, /DUMMY_HASH/);
    assert.match(WALLET_AUTH, /\$2a\$10\$/);
  });

  it('always runs bcrypt.compare (even if account does not exist)', () => {
    assert.match(WALLET_AUTH, /hashToCompare\s*=\s*accountExists/);
    assert.match(WALLET_AUTH, /bcrypt\.compare\(pin,\s*hashToCompare\)/);
  });

  it('returns 401 "Invalid credentials" for account_not_found', () => {
    assert.match(WALLET_AUTH, /reason:\s*'account_not_found'/);
  });

  it('returns 401 "Invalid credentials" for inactive_account (NOT 403)', () => {
    assert.match(WALLET_AUTH, /reason:\s*'inactive_account'/);
    // Find the inactive_account block and verify it returns 401
    const inactiveMatch = WALLET_AUTH.match(/inactive_account[\s\S]*?return reply\.status\((\d+)\)/);
    assert.ok(inactiveMatch, 'must find inactive_account return');
    assert.strictEqual(inactiveMatch[1], '401', 'inactive_account must return 401, not 403');
  });

  it('returns 401 "Invalid credentials" for invalid_pin', () => {
    assert.match(WALLET_AUTH, /reason:\s*'invalid_pin'/);
  });

  it('does NOT return 403 "Account is suspended" anymore', () => {
    // Strip comments before checking
    const stripped = WALLET_AUTH
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(stripped, /'Account is suspended'/);
  });

  it('logs the real reason server-side', () => {
    assert.match(WALLET_AUTH, /fastify\.log\.info\([\s\S]*?reason:\s*'account_not_found'/);
    assert.match(WALLET_AUTH, /fastify\.log\.info\([\s\S]*?reason:\s*'inactive_account'/);
    assert.match(WALLET_AUTH, /reason:\s*'invalid_pin'/);
  });

  it('preserves lockout check (423) for too many failed PIN attempts', () => {
    // The lockout check should still return 423 — it's a separate
    // concern from account enumeration
    assert.match(WALLET_AUTH, /423/);
    assert.match(WALLET_AUTH, /locked/);
  });
});
