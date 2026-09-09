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

  it('accepts a callback where phone lacks the country code (real Unipesa format)', () => {
    // Unipesa sends customer_id as "970967029" (no +243 prefix);
    // DB stores "+243970967029". These must match.
    const callback = { ...validCallback, phone: '970967029' };
    const tx = { ...transaction, phone: '+243970967029' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('accepts Airtel callback: DB E.164 vs callback local 9-digit', () => {
    // Airtel: callback sends "970967029" (9 digits, no prefix, no leading 0)
    const callback = { ...validCallback, phone: '970967029', operator: 'airtel' };
    const tx = { ...transaction, phone: '+243970967029', operator: 'airtel' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('accepts Orange callback: DB E.164 vs callback local 10-digit with leading 0', () => {
    // Orange: callback sends "0895363929" (10 digits, with leading 0)
    // DB stores "+243895363929" (E.164)
    const callback = { ...validCallback, phone: '0895363929', operator: 'orange' };
    const tx = { ...transaction, phone: '+243895363929', operator: 'orange' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('accepts Africell callback: DB E.164 vs callback local 10-digit with leading 0', () => {
    // Africell: callback sends "0901030625" (10 digits, with leading 0)
    // DB stores "+243901030625" (E.164)
    const callback = { ...validCallback, phone: '0901030625', operator: 'afrimoney' };
    const tx = { ...transaction, phone: '+243901030625', operator: 'afrimoney' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('accepts DB stored in local format (no +243) matching callback', () => {
    // DB sometimes stores local format without +243 (e.g. "997174834")
    const callback = { ...validCallback, phone: '997174834' };
    const tx = { ...transaction, phone: '997174834' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('accepts DB stored with leading 0 matching callback with leading 0', () => {
    // DB sometimes stores Orange local format "0895363929"
    const callback = { ...validCallback, phone: '0895363929', operator: 'orange' };
    const tx = { ...transaction, phone: '0895363929', operator: 'orange' };
    assert.deepEqual(validateProviderCallbackProof(callback, tx), { valid: true });
  });

  it('rejects a genuinely different phone even with country-code normalization', () => {
    const callback = { ...validCallback, phone: '970967029' };
    const tx = { ...transaction, phone: '+243811111111' };
    assert.equal(validateProviderCallbackProof(callback, tx).valid, false);
  });

  it('requires the route to reject an absent signature unconditionally', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/payment/callback.ts'), 'utf8');
    assert.match(source, /if \(!request\.body\?\.signature \|\| !verifyCallbackSignature/);
    assert.doesNotMatch(source, /'signature' in request\.body/);
  });
});
