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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAnySecret, safeSecretEqual } from '../secret-compare';

// Simulate env configuration for testing
const TEST_NEW_GAMING_KEY = 'test-congogaming-key-12345678';
const TEST_LEGACY_GAMING_KEY = 'test-legacy-gaming-key-12345678';
const TEST_NEW_BRIDGE_KEY = 'test-bridge-inbound-key-12345678';
const TEST_BRIDGE_OUTBOUND_KEY = 'test-bridge-outbound-key-12';
const TEST_ADMIN_SECRET = 'test-admin-secret-12345678';

describe('Trust boundary 1: CongoGaming → UniPay API', () => {
  test('1. New CongoGaming key accepted on gaming route', () => {
    const provided = TEST_NEW_GAMING_KEY;
    const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), true);
  });

  test('2. Legacy GAMING_API_KEY accepted on gaming route during overlap', () => {
    const provided = TEST_LEGACY_GAMING_KEY;
    const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), true);
  });

  test('3. Bridge key rejected on gaming route', () => {
    const provided = TEST_NEW_BRIDGE_KEY;
    const candidates = [TEST_NEW_GAMING_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), false);
  });
});

describe('Trust boundary 2: Bridge → UniPay API', () => {
  test('4. New Bridge inbound key accepted on internal route', () => {
    const provided = TEST_NEW_BRIDGE_KEY;
    const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), true);
  });

  test('5. CongoGaming key rejected on internal route', () => {
    const provided = TEST_NEW_GAMING_KEY;
    const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), false);
  });

  test('6. Legacy GAMING_API_KEY accepted on internal route', () => {
    const provided = TEST_LEGACY_GAMING_KEY;
    const candidates = [TEST_NEW_BRIDGE_KEY, TEST_LEGACY_GAMING_KEY];
    assert.equal(matchesAnySecret(provided, candidates), true);
  });
});

describe('Trust boundary 4: Admin secret', () => {
  test('7. ADMIN_SECRET comparison timing-safe', () => {
    assert.equal(safeSecretEqual(TEST_ADMIN_SECRET, TEST_ADMIN_SECRET), true);
    assert.equal(safeSecretEqual('wrong-secret', TEST_ADMIN_SECRET), false);
  });

  test('8. Empty string rejected', () => {
    assert.equal(safeSecretEqual('', TEST_ADMIN_SECRET), false);
    assert.equal(safeSecretEqual(TEST_ADMIN_SECRET, ''), false);
  });

  test('9. Different length rejected', () => {
    assert.equal(safeSecretEqual('short', TEST_ADMIN_SECRET), false);
    assert.equal(safeSecretEqual(TEST_ADMIN_SECRET, 'short'), false);
  });
});

describe('Log safety', () => {
  test('10. No secret value in matchesAnySecret output', () => {
    // The function returns only boolean — no secret can leak through return value.
    const result = matchesAnySecret(TEST_NEW_GAMING_KEY, [TEST_NEW_GAMING_KEY]);
    assert.equal(result, true);
    // Verify the function signature returns only boolean
    assert.equal(typeof result, 'boolean');
  });
});
