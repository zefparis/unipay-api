import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhoneForOperator,
  extractLocalDigits,
  isValidDrcPhone,
  type UnipesaOperator,
} from '../phone-normalization';

/**
 * Tests for MSISDN normalization per Unipesa documentation (docs.unipesa.tech).
 *
 * Reference formats from Unipesa docs for country=CD:
 *   Orange    (provider_id=10) : "0800000000"  (starts with 0)
 *   Airtel    (provider_id=17) : "999000000"   (no leading 0)
 *   Afrimoney (provider_id=19) : "0900000000"  (starts with 0)
 */

describe('extractLocalDigits', () => {
  it('extracts 9 digits from +243XXXXXXXXX format', () => {
    assert.equal(extractLocalDigits('+243997174834'), '997174834');
  });

  it('extracts 9 digits from 243XXXXXXXXX format (no +)', () => {
    assert.equal(extractLocalDigits('243997174834'), '997174834');
  });

  it('extracts 9 digits from 0XXXXXXXXX format', () => {
    assert.equal(extractLocalDigits('0997174834'), '997174834');
  });

  it('extracts 9 digits from bare XXXXXXXXX format', () => {
    assert.equal(extractLocalDigits('997174834'), '997174834');
  });

  it('handles spaces and dashes in input', () => {
    assert.equal(extractLocalDigits('+243 997 174 834'), '997174834');
    assert.equal(extractLocalDigits('+243-997-174-834'), '997174834');
  });

  it('returns null for too few digits', () => {
    assert.equal(extractLocalDigits('+24399717483'), null);  // 8 digits
  });

  it('returns null for too many digits', () => {
    assert.equal(extractLocalDigits('+2439971748340'), null); // 10 digits
  });

  it('returns null for non-numeric input', () => {
    assert.equal(extractLocalDigits('abc'), null);
    assert.equal(extractLocalDigits(''), null);
  });
});

describe('normalizePhoneForOperator — Orange (provider_id=10)', () => {
  const operator: UnipesaOperator = 'orange';

  it('transforms +243997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('+243997174834', operator), '0997174834');
  });

  it('transforms 243997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('243997174834', operator), '0997174834');
  });

  it('transforms 0997174834 → 0997174834 (already correct)', () => {
    assert.equal(normalizePhoneForOperator('0997174834', operator), '0997174834');
  });

  it('transforms 997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('997174834', operator), '0997174834');
  });

  // Reference example from Unipesa docs
  it('matches Unipesa doc reference: 0800000000', () => {
    assert.equal(normalizePhoneForOperator('0800000000', operator), '0800000000');
    assert.equal(normalizePhoneForOperator('+243800000000', operator), '0800000000');
    assert.equal(normalizePhoneForOperator('800000000', operator), '0800000000');
  });
});

describe('normalizePhoneForOperator — Airtel (provider_id=17)', () => {
  const operator: UnipesaOperator = 'airtel';

  it('transforms +243997174834 → 997174834 (no leading 0)', () => {
    assert.equal(normalizePhoneForOperator('+243997174834', operator), '997174834');
  });

  it('transforms 243997174834 → 997174834', () => {
    assert.equal(normalizePhoneForOperator('243997174834', operator), '997174834');
  });

  it('transforms 0997174834 → 997174834 (strips leading 0)', () => {
    assert.equal(normalizePhoneForOperator('0997174834', operator), '997174834');
  });

  it('transforms 997174834 → 997174834 (already correct)', () => {
    assert.equal(normalizePhoneForOperator('997174834', operator), '997174834');
  });

  // Reference example from Unipesa docs
  it('matches Unipesa doc reference: 999000000', () => {
    assert.equal(normalizePhoneForOperator('999000000', operator), '999000000');
    assert.equal(normalizePhoneForOperator('+243999000000', operator), '999000000');
    assert.equal(normalizePhoneForOperator('0999000000', operator), '999000000');
  });
});

describe('normalizePhoneForOperator — Afrimoney (provider_id=19)', () => {
  const operator: UnipesaOperator = 'afrimoney';

  it('transforms +243997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('+243997174834', operator), '0997174834');
  });

  it('transforms 243997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('243997174834', operator), '0997174834');
  });

  it('transforms 0997174834 → 0997174834 (already correct)', () => {
    assert.equal(normalizePhoneForOperator('0997174834', operator), '0997174834');
  });

  it('transforms 997174834 → 0997174834', () => {
    assert.equal(normalizePhoneForOperator('997174834', operator), '0997174834');
  });

  // Reference example from Unipesa docs
  it('matches Unipesa doc reference: 0900000000', () => {
    assert.equal(normalizePhoneForOperator('0900000000', operator), '0900000000');
    assert.equal(normalizePhoneForOperator('+243900000000', operator), '0900000000');
    assert.equal(normalizePhoneForOperator('900000000', operator), '0900000000');
  });
});

describe('normalizePhoneForOperator — error cases', () => {
  it('throws on invalid phone (too few digits)', () => {
    assert.throws(
      () => normalizePhoneForOperator('+24312345678', 'orange'),
      /Invalid phone number/,
    );
  });

  it('throws on invalid phone (too many digits)', () => {
    assert.throws(
      () => normalizePhoneForOperator('+2431234567890', 'orange'),
      /Invalid phone number/,
    );
  });

  it('throws on non-numeric input', () => {
    assert.throws(
      () => normalizePhoneForOperator('abcdef', 'airtel'),
      /Invalid phone number/,
    );
  });

  it('throws on empty string', () => {
    assert.throws(
      () => normalizePhoneForOperator('', 'orange'),
      /Invalid phone number/,
    );
  });
});

describe('isValidDrcPhone', () => {
  it('returns true for valid +243XXXXXXXXX', () => {
    assert.equal(isValidDrcPhone('+243997174834'), true);
  });

  it('returns true for valid 0XXXXXXXXX', () => {
    assert.equal(isValidDrcPhone('0997174834'), true);
  });

  it('returns true for valid bare 9 digits', () => {
    assert.equal(isValidDrcPhone('997174834'), true);
  });

  it('returns false for invalid phone', () => {
    assert.equal(isValidDrcPhone('+24312345678'), false);
    assert.equal(isValidDrcPhone('abc'), false);
    assert.equal(isValidDrcPhone(''), false);
  });
});

describe('normalizePhoneForOperator — cross-operator consistency', () => {
  // The same input phone must produce operator-specific output
  it('+243997174834 produces different formats for Orange vs Airtel', () => {
    const orange = normalizePhoneForOperator('+243997174834', 'orange');
    const airtel = normalizePhoneForOperator('+243997174834', 'airtel');
    assert.equal(orange, '0997174834');
    assert.equal(airtel, '997174834');
    assert.notEqual(orange, airtel);
  });

  it('+243997174834 produces same format for Orange and Afrimoney', () => {
    const orange = normalizePhoneForOperator('+243997174834', 'orange');
    const afrimoney = normalizePhoneForOperator('+243997174834', 'afrimoney');
    assert.equal(orange, afrimoney);
    assert.equal(orange, '0997174834');
  });
});
