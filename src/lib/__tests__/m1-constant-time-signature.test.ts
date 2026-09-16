import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M1 remediation tests — constant-time signature comparison.
 *
 * Verifies that webhook signature comparisons use safeSecretEqual
 * instead of === (which is vulnerable to timing attacks).
 */

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const AVADA = fs.readFileSync(path.resolve(SRC, 'services/avada.ts'), 'utf-8');
const UNIPESA = fs.readFileSync(path.resolve(SRC, 'lib/unipesa.ts'), 'utf-8');

describe('M1 — avada.ts uses safeSecretEqual for signature comparison', () => {
  it('imports safeSecretEqual from security/secret-compare', () => {
    assert.match(AVADA, /import.*safeSecretEqual.*from.*secret-compare/);
  });

  it('verifyCallbackSignature uses safeSecretEqual (not ===)', () => {
    const section = AVADA.match(/export function verifyCallbackSignature[\s\S]*?^}/m);
    assert.ok(section, 'must find verifyCallbackSignature function');
    assert.match(section[0], /safeSecretEqual/);
    assert.doesNotMatch(section[0], /===\s*expected/);
  });

  it('does NOT use === for signature comparison anywhere in the file', () => {
    // The only === involving "signature" should be the `key === 'signature'` skip
    // in calculateSignature, not a comparison of signature values
    const lines = AVADA.split('\n');
    for (const line of lines) {
      // Skip the `if (key === 'signature') continue` line
      if (/key\s*===\s*['"]signature['"]/.test(line)) continue;
      // Flag any === comparison involving signature or toLowerCase
      if (/signature.*===|===.*signature/.test(line) && !/safeSecretEqual/.test(line)) {
        assert.fail(`Unsafe signature comparison found: ${line.trim()}`);
      }
      if (/\.toLowerCase\(\)\s*===.*\.toLowerCase\(\)/.test(line)) {
        assert.fail(`Unsafe toLowerCase comparison found: ${line.trim()}`);
      }
    }
  });
});

describe('M1 — unipesa.ts uses safeSecretEqual for signature comparison', () => {
  it('imports safeSecretEqual from security/secret-compare', () => {
    assert.match(UNIPESA, /import.*safeSecretEqual.*from.*secret-compare/);
  });

  it('verifyCallbackSignature uses safeSecretEqual (not ===)', () => {
    const section = UNIPESA.match(/export function verifyCallbackSignature[\s\S]*?^}/m);
    assert.ok(section, 'must find verifyCallbackSignature function');
    assert.match(section[0], /safeSecretEqual/);
    assert.doesNotMatch(section[0], /===\s*expected/);
  });

  it('does NOT use === for signature comparison anywhere in the file', () => {
    const lines = UNIPESA.split('\n');
    for (const line of lines) {
      if (/key\s*===\s*['"]signature['"]/.test(line)) continue;
      if (/signature.*===|===.*signature/.test(line) && !/safeSecretEqual/.test(line)) {
        assert.fail(`Unsafe signature comparison found: ${line.trim()}`);
      }
      if (/\.toLowerCase\(\)\s*===.*\.toLowerCase\(\)/.test(line)) {
        assert.fail(`Unsafe toLowerCase comparison found: ${line.trim()}`);
      }
    }
  });
});
