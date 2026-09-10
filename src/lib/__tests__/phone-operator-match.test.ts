/**
 * Tests for phone-operator prefix matching.
 *
 * Validates that detectOperatorFromPhone and validatePhoneOperatorMatch
 * correctly identify the operator from a DRC phone number's prefix and
 * detect mismatches that would cause Unipesa B2C rejection (MSISDN
 * INCORRECT, code 10401).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectOperatorFromPhone,
  validatePhoneOperatorMatch,
} from '../phone-normalization';

describe('detectOperatorFromPhone', () => {
  it('detects Airtel from prefix 97', () => {
    assert.equal(detectOperatorFromPhone('+243970967029'), 'airtel');
  });

  it('detects Airtel from prefix 98', () => {
    assert.equal(detectOperatorFromPhone('+243981234567'), 'airtel');
  });

  it('detects Airtel from prefix 99', () => {
    assert.equal(detectOperatorFromPhone('+243998338854'), 'airtel');
  });

  it('detects Orange from prefix 84', () => {
    assert.equal(detectOperatorFromPhone('+243841234567'), 'orange');
  });

  it('detects Orange from prefix 88', () => {
    assert.equal(detectOperatorFromPhone('+243881234567'), 'orange');
  });

  it('detects Orange from prefix 89', () => {
    assert.equal(detectOperatorFromPhone('+243895363929'), 'orange');
  });

  it('detects Afrimoney from prefix 81', () => {
    assert.equal(detectOperatorFromPhone('+243811234567'), 'afrimoney');
  });

  it('detects Afrimoney from prefix 82', () => {
    assert.equal(detectOperatorFromPhone('+243821234567'), 'afrimoney');
  });

  it('detects Afrimoney from prefix 85', () => {
    assert.equal(detectOperatorFromPhone('+243851234567'), 'afrimoney');
  });

  it('detects Afrimoney from prefix 90', () => {
    assert.equal(detectOperatorFromPhone('+243901030625'), 'afrimoney');
  });

  it('returns null for unknown prefix', () => {
    assert.equal(detectOperatorFromPhone('+243501234567'), null);
  });

  it('returns null for invalid phone', () => {
    assert.equal(detectOperatorFromPhone('123'), null);
  });
});

describe('validatePhoneOperatorMatch', () => {
  it('returns ok=true when Airtel number matches Airtel operator', () => {
    const result = validatePhoneOperatorMatch('+243998338854', 'airtel');
    assert.equal(result.ok, true);
  });

  it('returns ok=true when Orange number matches Orange operator', () => {
    const result = validatePhoneOperatorMatch('+243895363929', 'orange');
    assert.equal(result.ok, true);
  });

  it('returns ok=true when Afrimoney number matches Afrimoney operator', () => {
    const result = validatePhoneOperatorMatch('+243901030625', 'afrimoney');
    assert.equal(result.ok, true);
  });

  it('returns ok=false when Airtel number is used with Orange operator', () => {
    // This is the exact scenario from transaction don_1789022428_1:
    // phone +243998338854 (Airtel prefix 99) sent on Orange channel.
    // Unipesa/Orange rejects with MSISDN INCORRECT.
    const result = validatePhoneOperatorMatch('+243998338854', 'orange');
    assert.equal(result.ok, false);
    assert.equal(result.detected, 'airtel');
    assert.match(result.message, /airtel/i);
    assert.match(result.message, /orange/i);
  });

  it('returns ok=false when Orange number is used with Airtel operator', () => {
    const result = validatePhoneOperatorMatch('+243895363929', 'airtel');
    assert.equal(result.ok, false);
    assert.equal(result.detected, 'orange');
  });

  it('returns ok=false when Airtel number is used with Afrimoney operator', () => {
    const result = validatePhoneOperatorMatch('+243998338854', 'afrimoney');
    assert.equal(result.ok, false);
    assert.equal(result.detected, 'airtel');
  });

  it('returns ok=true for unknown prefix (does not block)', () => {
    // Unknown prefixes should not be blocked — we don't want to reject
    // legitimate numbers from new prefix ranges.
    const result = validatePhoneOperatorMatch('+243501234567', 'orange');
    assert.equal(result.ok, true);
  });

  it('is case-insensitive on operator', () => {
    const result = validatePhoneOperatorMatch('+243998338854', 'ORANGE');
    assert.equal(result.ok, false);
    assert.equal(result.detected, 'airtel');
  });
});
