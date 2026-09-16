import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * C3 unlock-pin admin route tests.
 *
 * Verifies the admin unlock-pin route exists, is admin-protected,
 * resets the 3 lockout columns, logs the action, and handles the
 * ALREADY_UNLOCKED + not-found cases.
 */

const ROOT = path.resolve(__dirname, '../..');
const ADMIN_WALLET = fs.readFileSync(
  path.resolve(ROOT, 'routes/admin/wallet.ts'),
  'utf-8',
);

describe('C3-unlock — POST /v1/admin/wallet/users/:id/unlock-pin', () => {
  it('route is registered', () => {
    assert.match(
      ADMIN_WALLET,
      /\/admin\/wallet\/users\/:id\/unlock-pin/,
      'must register the unlock-pin route',
    );
  });

  it('is protected by requireAdmin(request.isAdmin)', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
    assert.ok(section, 'must find unlock-pin route body');
    assert.match(section[0], /requireAdmin\(request\.isAdmin\)/);
    assert.match(section[0], /403/);
    assert.match(section[0], /Admin access required/);
  });

  it('returns 404 when wallet_id does not exist', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
    assert.ok(section);
    assert.match(section[0], /404/);
    assert.match(section[0], /Wallet user not found/);
  });

  it('returns ALREADY_UNLOCKED when not currently locked', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
    assert.ok(section);
    assert.match(section[0], /ALREADY_UNLOCKED/);
    assert.match(section[0], /was_locked:\s*false/);
  });

  it('resets the 3 lockout columns (failed_pin_attempts, locked_until, pin_lockout_count)', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
    assert.ok(section);
    assert.match(section[0], /failed_pin_attempts:\s*0/);
    assert.match(section[0], /locked_until:\s*null/);
    assert.match(section[0], /pin_lockout_count:\s*0/);
  });

  it('logs the action via logAdminAction with action wallet_user.unlock_pin', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/unlock-pin[\s\S]*?return reply\.send\(\{ ok: true, was_locked: true \}\)/);
    assert.ok(section);
    assert.match(section[0], /logAdminAction/);
    assert.match(section[0], /wallet_user\.unlock_pin/);
    assert.match(section[0], /wallet_user/);
    // Must capture previous state for forensics
    assert.match(section[0], /previous_failed_pin_attempts/);
    assert.match(section[0], /previous_pin_lockout_count/);
    assert.match(section[0], /previous_locked_until/);
  });
});

describe('C3-unlock — GET /v1/admin/wallet/users/:id/lockout-status', () => {
  it('route is registered', () => {
    assert.match(
      ADMIN_WALLET,
      /\/admin\/wallet\/users\/:id\/lockout-status/,
      'must register the lockout-status route',
    );
  });

  it('is admin-protected', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?return reply\.send\(\{[\s\S]*?\}\s*\)/);
    assert.ok(section, 'must find lockout-status route body');
    assert.match(section[0], /requireAdmin\(request\.isAdmin\)/);
  });

  it('returns 404 when wallet not found', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?(?=\/\*|$)/);
    assert.ok(section);
    assert.match(section[0], /404/);
  });

  it('returns is_locked, is_permanent, and lockout fields', () => {
    const section = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id\/lockout-status[\s\S]*?(?=\/\*|$)/);
    assert.ok(section);
    assert.match(section[0], /is_locked/);
    assert.match(section[0], /is_permanent/);
    assert.match(section[0], /failed_pin_attempts/);
    assert.match(section[0], /locked_until/);
    assert.match(section[0], /pin_lockout_count/);
  });
});

describe('C3-unlock — list and detail routes expose lockout columns', () => {
  it('GET /admin/wallet/users list selects locked_until', () => {
    // The list route section spans from the route declaration to the next route
    const listSection = ADMIN_WALLET.match(/\/admin\/wallet\/users'[\s\S]*?\/admin\/wallet\/users\/:id/);
    assert.ok(listSection, 'must find list route section');
    assert.match(listSection[0], /locked_until/);
    assert.match(listSection[0], /pin_lockout_count/);
  });

  it('GET /admin/wallet/users/:id detail selects locked_until', () => {
    // The detail route section spans from the route declaration to the next route (block)
    const detailSection = ADMIN_WALLET.match(/\/admin\/wallet\/users\/:id'[\s\S]*?\/admin\/wallet\/users\/:id\/block/);
    assert.ok(detailSection, 'must find detail route section');
    assert.match(detailSection[0], /locked_until/);
    assert.match(detailSection[0], /pin_lockout_count/);
  });
});
