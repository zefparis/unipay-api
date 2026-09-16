import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * C3 remediation tests — rate-limit bypass fix + PIN lockout.
 *
 * Verifies:
 *   1. The global rate-limit keyGenerator no longer trusts x-api-key.
 *   2. trustProxy is enabled so req.ip is the real client IP.
 *   3. All 5 auth routes have explicit IP-based rateLimit configs.
 *   4. The pin-lockout helper implements escalating lockout durations.
 *   5. The wallet login route checks lockout before PIN verification.
 */

const ROOT = path.resolve(__dirname, '../..');
const SERVER = fs.readFileSync(path.resolve(ROOT, 'server.ts'), 'utf-8');
const AUTH = fs.readFileSync(path.resolve(ROOT, 'routes/wallet/auth.ts'), 'utf-8');
const MERCHANT_LOGIN = fs.readFileSync(path.resolve(ROOT, 'routes/merchant/login.ts'), 'utf-8');
const MERCHANT_REGISTER = fs.readFileSync(path.resolve(ROOT, 'routes/merchant/register.ts'), 'utf-8');
const PIN_LOCKOUT = fs.readFileSync(path.resolve(ROOT, 'lib/pin-lockout.ts'), 'utf-8');

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), 'utf-8');
}

// ─── C3.1: Global keyGenerator no longer trusts x-api-key ───────

describe('C3.1 — Global keyGenerator uses req.ip only', () => {
  it('does not use x-api-key in the global keyGenerator function', () => {
    // Extract just the keyGenerator line (not comments)
    const keyGenMatch = SERVER.match(/keyGenerator:\s*\(req\)\s*=>\s*([^,;\n]+)/);
    assert.ok(keyGenMatch, 'must find global keyGenerator');
    const keyGenBody = keyGenMatch[1];
    assert.doesNotMatch(
      keyGenBody,
      /x-api-key/,
      'global keyGenerator must NOT use x-api-key header',
    );
    assert.match(
      keyGenBody,
      /req\.ip/,
      'global keyGenerator must use req.ip',
    );
  });
});

// ─── C3.2: trustProxy enabled ──────────────────────────────────

describe('C3.2 — trustProxy is enabled', () => {
  it('Fastify is instantiated with trustProxy: true', () => {
    assert.match(
      SERVER,
      /trustProxy:\s*true/,
      'must enable trustProxy so req.ip reflects the real client IP behind the proxy',
    );
  });
});

// ─── C3.3: Auth routes have explicit IP-based rateLimit ────────

describe('C3.3 — Auth routes have explicit IP-based rateLimit', () => {
  it('POST /wallet/login has rateLimit with IP keyGenerator', () => {
    const section = AUTH.match(/\/wallet\/login[\s\S]*?async\s*\(request/);
    assert.ok(section, 'must find wallet/login route');
    assert.match(section[0], /rateLimit/);
    assert.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });

  it('POST /wallet/register has rateLimit with IP keyGenerator', () => {
    const section = AUTH.match(/\/wallet\/register[\s\S]*?async\s*\(request/);
    assert.ok(section, 'must find wallet/register route');
    assert.match(section[0], /rateLimit/);
    assert.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });

  it('POST /wallet/auth/refresh has rateLimit with IP keyGenerator', () => {
    const section = AUTH.match(/\/wallet\/auth\/refresh[\s\S]*?async\s*\(request/);
    assert.ok(section, 'must find wallet/auth/refresh route');
    assert.match(section[0], /rateLimit/);
    assert.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });

  it('POST /wallet/auth/change-pin has rateLimit with IP keyGenerator', () => {
    const section = AUTH.match(/\/wallet\/auth\/change-pin[\s\S]*?async\s*\(request/);
    assert.ok(section, 'must find wallet/auth/change-pin route');
    assert.match(section[0], /rateLimit/);
    assert.match(section[0], /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });

  it('POST /merchant/login has rateLimit with IP keyGenerator', () => {
    assert.match(MERCHANT_LOGIN, /rateLimit/);
    assert.match(MERCHANT_LOGIN, /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });

  it('POST /merchant/register has rateLimit with IP keyGenerator', () => {
    assert.match(MERCHANT_REGISTER, /rateLimit/);
    assert.match(MERCHANT_REGISTER, /keyGenerator:\s*\(req\)\s*=>\s*req\.ip/);
  });
});

// ─── C3.4: PIN lockout helper ──────────────────────────────────

describe('C3.4 — pin-lockout helper', () => {
  it('exports MAX_FAILED_PIN_ATTEMPTS = 5', () => {
    assert.match(PIN_LOCKOUT, /MAX_FAILED_PIN_ATTEMPTS\s*=\s*5/);
  });

  it('implements escalating lockout durations', () => {
    assert.match(PIN_LOCKOUT, /15\s*\*\s*60\s*\*\s*1000/);   // 15 min
    assert.match(PIN_LOCKOUT, /60\s*\*\s*60\s*\*\s*1000/);   // 1 h
    assert.match(PIN_LOCKOUT, /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/); // 24 h
    assert.match(PIN_LOCKOUT, /MAX_SAFE_INTEGER/);           // permanent
  });

  it('exports recordFailedPinAttempt and resetPinLockout', () => {
    assert.match(PIN_LOCKOUT, /export async function recordFailedPinAttempt/);
    assert.match(PIN_LOCKOUT, /export async function resetPinLockout/);
  });

  it('resets all three counters on success (including pin_lockout_count)', () => {
    const resetBlock = PIN_LOCKOUT.match(/resetPinLockout[\s\S]*?\}\s*\)/);
    assert.ok(resetBlock);
    assert.match(resetBlock[0], /failed_pin_attempts:\s*0/);
    assert.match(resetBlock[0], /locked_until:\s*null/);
    assert.match(resetBlock[0], /pin_lockout_count:\s*0/);
  });
});

// ─── C3.5: Wallet login checks lockout before PIN ─────────────

describe('C3.5 — wallet/login checks lockout', () => {
  it('selects lockout columns from wallet_users in login route', () => {
    // Find the login route handler body (up to the next route or end of plugin)
    const loginSection = AUTH.match(/\/wallet\/login[\s\S]*?\/wallet\/auth\/refresh/);
    assert.ok(loginSection, 'must find wallet/login route section');
    const selectMatch = loginSection[0].match(/from\('wallet_users'\)[\s\S]*?\.maybeSingle\(\)/);
    assert.ok(selectMatch, 'must find wallet_users select in login route');
    assert.match(selectMatch[0], /failed_pin_attempts/);
    assert.match(selectMatch[0], /locked_until/);
    assert.match(selectMatch[0], /pin_lockout_count/);
  });

  it('returns 423 when account is locked', () => {
    assert.match(AUTH, /status\(423\)/);
    assert.match(AUTH, /Account temporarily locked|Account locked/);
  });

  it('calls recordFailedPinAttempt on PIN failure', () => {
    assert.match(AUTH, /recordFailedPinAttempt/);
  });

  it('calls resetPinLockout on PIN success', () => {
    assert.match(AUTH, /resetPinLockout/);
  });
});

// ─── C3.6: change-pin also has lockout ─────────────────────────

describe('C3.6 — change-pin has lockout', () => {
  it('selects lockout columns', () => {
    const changePinSection = AUTH.match(/\/wallet\/auth\/change-pin[\s\S]*?(async|return)/);
    assert.ok(changePinSection);
    // The select in change-pin should include lockout columns
    assert.match(AUTH, /failed_pin_attempts, locked_until, pin_lockout_count/);
  });

  it('returns 423 when locked', () => {
    // Count 423 occurrences — login + change-pin both use it
    const matches = AUTH.match(/status\(423\)/g);
    assert.ok(matches && matches.length >= 2, `expected ≥2 status(423) in auth.ts, got ${matches?.length}`);
  });
});

// ─── C3.7: sensitive-session/reactivate has lockout ────────────

describe('C3.7 — sensitive-session/reactivate has lockout', () => {
  const SRC = readSrc('routes/wallet/sensitive-session.ts');

  it('imports pin-lockout helpers', () => {
    assert.match(SRC, /from '.*pin-lockout/);
    assert.match(SRC, /getLockoutDeadline/);
    assert.match(SRC, /recordFailedPinAttempt/);
    assert.match(SRC, /resetPinLockout/);
  });

  it('returns 423 when locked', () => {
    assert.match(SRC, /status\(423\)/);
  });
});

// ─── C3.8: Migration exists ─────────────────────────────────────

describe('C3.8 — lockout migration', () => {
  const MIGRATIONS = path.resolve(ROOT, '../supabase/migrations');
  const files = fs.readdirSync(MIGRATIONS);
  const lockoutMigration = files.find(f => f.includes('wallet_pin_lockout'));

  it('a migration file adds lockout columns to wallet_users', () => {
    assert.ok(lockoutMigration, 'must have a migration file for wallet PIN lockout');
  });

  if (lockoutMigration) {
    const migrationSrc = fs.readFileSync(
      path.resolve(MIGRATIONS, lockoutMigration),
      'utf-8',
    );

    it('adds failed_pin_attempts column', () => {
      assert.match(migrationSrc, /ADD COLUMN IF NOT EXISTS failed_pin_attempts/);
    });

    it('adds locked_until column', () => {
      assert.match(migrationSrc, /ADD COLUMN IF NOT EXISTS locked_until/);
    });

    it('adds pin_lockout_count column', () => {
      assert.match(migrationSrc, /ADD COLUMN IF NOT EXISTS pin_lockout_count/);
    });
  }
});
