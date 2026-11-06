"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const phone_normalization_1 = require("../phone-normalization");
/**
 * Tests for MSISDN normalization per Unipesa documentation (docs.unipesa.tech).
 *
 * Reference formats from Unipesa docs for country=CD:
 *   Orange    (provider_id=10) : "0800000000"  (starts with 0)
 *   Airtel    (provider_id=17) : "999000000"   (no leading 0)
 *   Afrimoney (provider_id=19) : "0900000000"  (starts with 0)
 */
(0, node_test_1.describe)('extractLocalDigits', () => {
    (0, node_test_1.it)('extracts 9 digits from +243XXXXXXXXX format', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243997174834'), '997174834');
    });
    (0, node_test_1.it)('extracts 9 digits from 243XXXXXXXXX format (no +)', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('243997174834'), '997174834');
    });
    (0, node_test_1.it)('extracts 9 digits from 0XXXXXXXXX format', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('0997174834'), '997174834');
    });
    (0, node_test_1.it)('extracts 9 digits from bare XXXXXXXXX format', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('997174834'), '997174834');
    });
    (0, node_test_1.it)('handles spaces and dashes in input', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243 997 174 834'), '997174834');
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243-997-174-834'), '997174834');
    });
    (0, node_test_1.it)('returns null for too few digits', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+24399717483'), null); // 8 digits
    });
    (0, node_test_1.it)('returns null for too many digits', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+2439971748340'), null); // 10 digits
    });
    (0, node_test_1.it)('returns null for non-numeric input', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('abc'), null);
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)(''), null);
    });
});
(0, node_test_1.describe)('normalizePhoneForOperator — Orange (provider_id=10)', () => {
    const operator = 'orange';
    (0, node_test_1.it)('transforms +243997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 243997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('243997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 0997174834 → 0997174834 (already correct)', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('997174834', operator), '0997174834');
    });
    // Reference example from Unipesa docs
    (0, node_test_1.it)('matches Unipesa doc reference: 0800000000', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0800000000', operator), '0800000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243800000000', operator), '0800000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('800000000', operator), '0800000000');
    });
});
(0, node_test_1.describe)('normalizePhoneForOperator — Airtel (provider_id=17)', () => {
    const operator = 'airtel';
    (0, node_test_1.it)('transforms +243997174834 → 997174834 (no leading 0)', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', operator), '997174834');
    });
    (0, node_test_1.it)('transforms 243997174834 → 997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('243997174834', operator), '997174834');
    });
    (0, node_test_1.it)('transforms 0997174834 → 997174834 (strips leading 0)', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0997174834', operator), '997174834');
    });
    (0, node_test_1.it)('transforms 997174834 → 997174834 (already correct)', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('997174834', operator), '997174834');
    });
    // Reference example from Unipesa docs
    (0, node_test_1.it)('matches Unipesa doc reference: 999000000', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('999000000', operator), '999000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243999000000', operator), '999000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0999000000', operator), '999000000');
    });
});
(0, node_test_1.describe)('normalizePhoneForOperator — Afrimoney (provider_id=19)', () => {
    const operator = 'afrimoney';
    (0, node_test_1.it)('transforms +243997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 243997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('243997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 0997174834 → 0997174834 (already correct)', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0997174834', operator), '0997174834');
    });
    (0, node_test_1.it)('transforms 997174834 → 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('997174834', operator), '0997174834');
    });
    // Reference example from Unipesa docs
    (0, node_test_1.it)('matches Unipesa doc reference: 0900000000', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0900000000', operator), '0900000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243900000000', operator), '0900000000');
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('900000000', operator), '0900000000');
    });
});
(0, node_test_1.describe)('normalizePhoneForOperator — error cases', () => {
    (0, node_test_1.it)('throws on invalid phone (too few digits)', () => {
        strict_1.default.throws(() => (0, phone_normalization_1.normalizePhoneForOperator)('+24312345678', 'orange'), /Invalid phone number/);
    });
    (0, node_test_1.it)('throws on invalid phone (too many digits)', () => {
        strict_1.default.throws(() => (0, phone_normalization_1.normalizePhoneForOperator)('+2431234567890', 'orange'), /Invalid phone number/);
    });
    (0, node_test_1.it)('throws on non-numeric input', () => {
        strict_1.default.throws(() => (0, phone_normalization_1.normalizePhoneForOperator)('abcdef', 'airtel'), /Invalid phone number/);
    });
    (0, node_test_1.it)('throws on empty string', () => {
        strict_1.default.throws(() => (0, phone_normalization_1.normalizePhoneForOperator)('', 'orange'), /Invalid phone number/);
    });
});
(0, node_test_1.describe)('isValidDrcPhone', () => {
    (0, node_test_1.it)('returns true for valid +243XXXXXXXXX', () => {
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('+243997174834'), true);
    });
    (0, node_test_1.it)('returns true for valid 0XXXXXXXXX', () => {
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('0997174834'), true);
    });
    (0, node_test_1.it)('returns true for valid bare 9 digits', () => {
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('997174834'), true);
    });
    (0, node_test_1.it)('returns false for invalid phone', () => {
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('+24312345678'), false);
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('abc'), false);
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)(''), false);
    });
});
(0, node_test_1.describe)('normalizePhoneForOperator — cross-operator consistency', () => {
    // The same input phone must produce operator-specific output
    (0, node_test_1.it)('+243997174834 produces different formats for Orange vs Airtel', () => {
        const orange = (0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', 'orange');
        const airtel = (0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', 'airtel');
        strict_1.default.equal(orange, '0997174834');
        strict_1.default.equal(airtel, '997174834');
        strict_1.default.notEqual(orange, airtel);
    });
    (0, node_test_1.it)('+243997174834 produces same format for Orange and Afrimoney', () => {
        const orange = (0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', 'orange');
        const afrimoney = (0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', 'afrimoney');
        strict_1.default.equal(orange, afrimoney);
        strict_1.default.equal(orange, '0997174834');
    });
});
(0, node_test_1.describe)('extractLocalDigits — defensive double-prefix handling', () => {
    (0, node_test_1.it)('extracts from 0243XXXXXXXXX (trunk 0 before country code)', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('0243997174834'), '997174834');
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('00243997174834'), '997174834');
    });
    (0, node_test_1.it)('extracts from 243243XXXXXXXXX (duplicated country code)', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('243243997174834'), '997174834');
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243243997174834'), '997174834');
    });
    (0, node_test_1.it)('extracts from "+243 0 997 174 834" (code + trunk 0 + spaces)', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243 0 997 174 834'), '997174834');
    });
    (0, node_test_1.it)('extracts from 2430XXXXXXXXX (code then trunk 0)', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('2430997174834'), '997174834');
    });
    (0, node_test_1.it)('still rejects ambiguous garbage', () => {
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('243243243'), null);
        strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('243243243243'), null);
    });
});
(0, node_test_1.describe)('normalizeToE164 — multi-country', () => {
    (0, node_test_1.it)('normalizes French numbers to E.164', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+33 6 12 34 56 78'), '+33612345678');
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+33612345678'), '+33612345678');
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('0033612345678'), '+33612345678');
    });
    (0, node_test_1.it)('normalizes DRC numbers to E.164', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+243997174834'), '+243997174834');
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+243 997 174 834'), '+243997174834');
    });
    (0, node_test_1.it)('rescues DRC defensive cases via the local-digits fallback', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+243243997174834'), '+243997174834');
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('0243997174834'), '+243997174834');
    });
    (0, node_test_1.it)('normalizes other supported countries', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+225 07 07 07 07 07'), '+2250707070707');
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+1 202 456 1414'), '+12024561414');
    });
    (0, node_test_1.it)('returns null for invalid / unresolvable input', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('abc'), null);
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)('+24312345678'), null);
        strict_1.default.equal((0, phone_normalization_1.normalizeToE164)(''), null);
    });
});
//# sourceMappingURL=phone-normalization.test.js.map