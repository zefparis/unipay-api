/**
 * Tests for outgoing phone formatting per operator (Unipesa /payment_c2b).
 *
 * Verifies that normalizePhoneForOperator produces the correct MSISDN
 * format for each DRC operator:
 *   - Airtel (17): 9 digits, no leading 0  (e.g. 970967029)
 *   - Orange (10): 10 digits, with leading 0 (e.g. 0895363929)
 *   - Afrimoney (19): 10 digits, with leading 0 (e.g. 0901030625)
 *
 * This is the OUTGOING format (what we send to Unipesa in the
 * customer_id field of /payment_c2b). It is separate from the
 * INCOMING callback proof comparison (provider-callback-proof.ts)
 * which normalizes for comparison, not for sending.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneForOperator, extractLocalDigits } from '../phone-normalization';

describe('outgoing phone format — per operator', () => {
  describe('Airtel (provider_id=17) — 9 digits, no leading 0', () => {
    it('formats E.164 input correctly', () => {
      assert.equal(normalizePhoneForOperator('+243970967029', 'airtel'), '970967029');
      assert.equal(normalizePhoneForOperator('+243998338854', 'airtel'), '998338854');
    });

    it('formats local-with-0 input correctly (strips the 0)', () => {
      assert.equal(normalizePhoneForOperator('0970967029', 'airtel'), '970967029');
    });

    it('formats bare 9-digit input correctly', () => {
      assert.equal(normalizePhoneForOperator('970967029', 'airtel'), '970967029');
    });

    it('formats E.164 without + correctly', () => {
      assert.equal(normalizePhoneForOperator('243970967029', 'airtel'), '970967029');
    });

    it('never produces a leading 0', () => {
      const result = normalizePhoneForOperator('+243970967029', 'airtel');
      assert.ok(!result.startsWith('0'), `Airtel MSISDN must not start with 0, got: ${result}`);
      assert.equal(result.length, 9);
    });
  });

  describe('Orange (provider_id=10) — 10 digits, with leading 0', () => {
    it('formats E.164 input correctly', () => {
      assert.equal(normalizePhoneForOperator('+243895363929', 'orange'), '0895363929');
      assert.equal(normalizePhoneForOperator('+243892646513', 'orange'), '0892646513');
    });

    it('formats local-with-0 input correctly (keeps the 0)', () => {
      assert.equal(normalizePhoneForOperator('0895363929', 'orange'), '0895363929');
    });

    it('formats bare 9-digit input correctly (adds the 0)', () => {
      assert.equal(normalizePhoneForOperator('895363929', 'orange'), '0895363929');
    });

    it('always produces a leading 0 and 10 digits', () => {
      const result = normalizePhoneForOperator('+243895363929', 'orange');
      assert.ok(result.startsWith('0'), `Orange MSISDN must start with 0, got: ${result}`);
      assert.equal(result.length, 10);
    });
  });

  describe('Afrimoney (provider_id=19) — 10 digits, with leading 0', () => {
    it('formats E.164 input correctly', () => {
      assert.equal(normalizePhoneForOperator('+243901030625', 'afrimoney'), '0901030625');
    });

    it('formats local-with-0 input correctly (keeps the 0)', () => {
      assert.equal(normalizePhoneForOperator('0901030625', 'afrimoney'), '0901030625');
    });

    it('formats bare 9-digit input correctly (adds the 0)', () => {
      assert.equal(normalizePhoneForOperator('901030625', 'afrimoney'), '0901030625');
    });

    it('always produces a leading 0 and 10 digits', () => {
      const result = normalizePhoneForOperator('+243901030625', 'afrimoney');
      assert.ok(result.startsWith('0'), `Afrimoney MSISDN must start with 0, got: ${result}`);
      assert.equal(result.length, 10);
    });
  });

  describe('Africell (provider_id=19) — same as Afrimoney', () => {
    it('formats correctly with leading 0', () => {
      assert.equal(normalizePhoneForOperator('+243901030625', 'africell'), '0901030625');
    });
  });

  describe('cross-operator: same phone, different formats', () => {
    it('Airtel number 998338854 sent on Airtel → 998338854 (9 digits)', () => {
      const result = normalizePhoneForOperator('+243998338854', 'airtel');
      assert.equal(result, '998338854');
      assert.equal(result.length, 9);
    });

    it('Airtel number 998338854 sent on Orange → 0998338854 (10 digits, correct FORMAT but wrong OPERATOR)', () => {
      // This is the scenario from transaction don_1789022428_1:
      // phone +243998338854 (Airtel prefix 99) sent on Orange channel.
      // Our code correctly formats it as 0998338854 (10 digits with 0),
      // but Unipesa/Orange rejects it with MSISDN INCORRECT because
      // the number doesn't belong to Orange's network.
      const result = normalizePhoneForOperator('+243998338854', 'orange');
      assert.equal(result, '0998338854');
      assert.equal(result.length, 10);
      assert.ok(result.startsWith('0'));
    });
  });

  describe('extractLocalDigits', () => {
    it('extracts 9 digits from E.164', () => {
      assert.equal(extractLocalDigits('+243970967029'), '970967029');
    });

    it('extracts 9 digits from local with 0', () => {
      assert.equal(extractLocalDigits('0970967029'), '970967029');
    });

    it('extracts 9 digits from bare local', () => {
      assert.equal(extractLocalDigits('970967029'), '970967029');
    });

    it('returns null for invalid input', () => {
      assert.equal(extractLocalDigits('123'), null);
      assert.equal(extractLocalDigits('+243123'), null);
    });
  });

  describe('avada.ts uses formatPhoneForOperator for outgoing', () => {
    // Static check: the initiateCollection function in avada.ts
    // must use formatPhoneForOperator, not normalizePhone directly.
    const fs = require('fs');
    const path = require('path');
    const avada = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/avada.ts'),
      'utf8',
    );

    it('imports normalizePhoneForOperator', () => {
      assert.match(avada, /from '\.\.\/lib\/phone-normalization'/);
    });

    it('defines formatPhoneForOperator that delegates to normalizePhoneForOperator', () => {
      assert.match(avada, /function formatPhoneForOperator/);
      assert.match(avada, /normalizePhoneForOperator/);
    });

    it('initiateCollection uses formatPhoneForOperator for customer_id', () => {
      assert.match(avada, /customer_id:\s*formatPhoneForOperator\(phone, operator\)/);
    });

    it('initiatePayout uses formatPhoneForOperator for customer_id', () => {
      assert.match(avada, /customer_id:\s*formatPhoneForOperator\(phone, operator\)/);
    });
  });
});
