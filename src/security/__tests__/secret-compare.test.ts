/**
 * Trust Boundary Patch Tests (Phase 05B0)
 *
 * Tests 1-10: Verify trust boundary separation, dual-key support,
 * timing-safe comparisons, and cross-boundary key rejection.
 *
 * Run with: npx tsx --test src/security/__tests__/secret-compare.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeSecretEqual, matchesAnySecret } from '../secret-compare';

describe('safeSecretEqual', () => {
  test('returns true for identical strings', () => {
    assert.equal(safeSecretEqual('secret123', 'secret123'), true);
  });

  test('returns false for different strings', () => {
    assert.equal(safeSecretEqual('secret123', 'secret456'), false);
  });

  test('returns false for empty provided', () => {
    assert.equal(safeSecretEqual('', 'expected'), false);
  });

  test('returns false for empty expected', () => {
    assert.equal(safeSecretEqual('provided', ''), false);
  });

  test('returns false for undefined provided', () => {
    assert.equal(safeSecretEqual(undefined, 'expected'), false);
  });

  test('returns false for null provided', () => {
    assert.equal(safeSecretEqual(null, 'expected'), false);
  });

  test('returns false for undefined expected', () => {
    assert.equal(safeSecretEqual('provided', undefined), false);
  });

  test('returns false for null expected', () => {
    assert.equal(safeSecretEqual('provided', null), false);
  });

  test('returns false for different-length strings', () => {
    assert.equal(safeSecretEqual('short', 'muchlongerstring'), false);
  });

  test('returns false when both are empty', () => {
    assert.equal(safeSecretEqual('', ''), false);
  });

  test('does not trim or normalize secrets', () => {
    assert.equal(safeSecretEqual(' secret ', ' secret '), true);
    assert.equal(safeSecretEqual(' secret ', 'secret'), false);
  });
});

describe('matchesAnySecret', () => {
  test('matches first candidate', () => {
    assert.equal(matchesAnySecret('key-a', ['key-a', 'key-b']), true);
  });

  test('matches second candidate', () => {
    assert.equal(matchesAnySecret('key-b', ['key-a', 'key-b']), true);
  });

  test('matches legacy fallback', () => {
    assert.equal(matchesAnySecret('legacy-key', [undefined, 'legacy-key']), true);
  });

  test('matches new key when both present', () => {
    assert.equal(matchesAnySecret('new-key', ['new-key', 'old-key']), true);
  });

  test('matches legacy key when both present', () => {
    assert.equal(matchesAnySecret('old-key', ['new-key', 'old-key']), true);
  });

  test('rejects key from different trust boundary', () => {
    assert.equal(matchesAnySecret('bridge-key', ['gaming-key', undefined]), false);
  });

  test('rejects empty provided', () => {
    assert.equal(matchesAnySecret('', ['key-a', 'key-b']), false);
  });

  test('rejects when no candidates provided', () => {
    assert.equal(matchesAnySecret('key-a', []), false);
  });

  test('rejects when all candidates are undefined/null', () => {
    assert.equal(matchesAnySecret('key-a', [undefined, null]), false);
  });

  test('rejects wrong key', () => {
    assert.equal(matchesAnySecret('wrong-key', ['correct-key']), false);
  });
});
