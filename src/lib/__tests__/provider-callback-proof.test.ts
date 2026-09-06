import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateProviderCallbackProof } from '../provider-callback-proof.js';

const validCallback = {
  reference: 'WD-12345678',
  amount: 1000,
  phone: '+243900000000',
  operator: 'orange',
  currency: 'CDF',
};

const transaction = {
  reference: 'WD-12345678',
  amount: 1000,
  phone: '+243900000000',
  operator: 'orange',
  currency: 'CDF',
};

describe('provider callback proof', () => {
  it('accepts a callback matching the stored transaction', () => {
    assert.deepEqual(validateProviderCallbackProof(validCallback, transaction), { valid: true });
  });

  it('rejects a signed callback with a different amount', () => {
    assert.deepEqual(
      validateProviderCallbackProof({ ...validCallback, amount: 1 }, transaction),
      { valid: false, reason: 'AMOUNT_MISMATCH' },
    );
  });

  it('rejects mismatched reference, phone, operator, and currency', () => {
    assert.equal(validateProviderCallbackProof({ ...validCallback, reference: 'WD-OTHER' }, transaction).valid, false);
    assert.equal(validateProviderCallbackProof({ ...validCallback, phone: '+243811111111' }, transaction).valid, false);
    assert.equal(validateProviderCallbackProof({ ...validCallback, operator: 'airtel' }, transaction).valid, false);
    assert.equal(validateProviderCallbackProof({ ...validCallback, currency: 'USD' }, transaction).valid, false);
  });

  it('requires the route to reject an absent signature unconditionally', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/payment/callback.ts'), 'utf8');
    assert.match(source, /if \(!request\.body\?\.signature \|\| !verifyCallbackSignature/);
    assert.doesNotMatch(source, /'signature' in request\.body/);
  });
});
