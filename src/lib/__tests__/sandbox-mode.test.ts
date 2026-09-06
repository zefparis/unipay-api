import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isSandboxAllowed } from '../sandbox-mode.js';

describe('isSandboxAllowed', () => {
  it('ignores a client sandbox header in production', () => {
    assert.equal(isSandboxAllowed('production', 'sandbox'), false);
  });

  it('allows sandbox only outside production when explicitly requested', () => {
    assert.equal(isSandboxAllowed('development', 'sandbox'), true);
    assert.equal(isSandboxAllowed('test', 'sandbox'), true);
    assert.equal(isSandboxAllowed('development', undefined), false);
  });

  it('routes every client sandbox header through the server-side environment guard', () => {
    for (const route of [
      'src/routes/wallet/deposit.ts',
      'src/routes/wallet/withdraw.ts',
      'src/routes/payment/initiate.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), route), 'utf8');
      assert.match(source, /isSandboxAllowed\(env\.NODE_ENV, request\.headers\['x-unipay-mode'\]\)/);
      assert.doesNotMatch(source, /request\.headers\['x-unipay-mode'\] === 'sandbox'/);
    }
  });
});
