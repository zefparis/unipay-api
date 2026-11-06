"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const phone_normalization_1 = require("../phone-normalization");
(0, node_test_1.describe)('outgoing phone format — per operator', () => {
    (0, node_test_1.describe)('Airtel (provider_id=17) — 9 digits, no leading 0', () => {
        (0, node_test_1.it)('formats E.164 input correctly', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243970967029', 'airtel'), '970967029');
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243998338854', 'airtel'), '998338854');
        });
        (0, node_test_1.it)('formats local-with-0 input correctly (strips the 0)', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0970967029', 'airtel'), '970967029');
        });
        (0, node_test_1.it)('formats bare 9-digit input correctly', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('970967029', 'airtel'), '970967029');
        });
        (0, node_test_1.it)('formats E.164 without + correctly', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('243970967029', 'airtel'), '970967029');
        });
        (0, node_test_1.it)('never produces a leading 0', () => {
            const result = (0, phone_normalization_1.normalizePhoneForOperator)('+243970967029', 'airtel');
            strict_1.default.ok(!result.startsWith('0'), `Airtel MSISDN must not start with 0, got: ${result}`);
            strict_1.default.equal(result.length, 9);
        });
    });
    (0, node_test_1.describe)('Orange (provider_id=10) — 10 digits, with leading 0', () => {
        (0, node_test_1.it)('formats E.164 input correctly', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243895363929', 'orange'), '0895363929');
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243892646513', 'orange'), '0892646513');
        });
        (0, node_test_1.it)('formats local-with-0 input correctly (keeps the 0)', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0895363929', 'orange'), '0895363929');
        });
        (0, node_test_1.it)('formats bare 9-digit input correctly (adds the 0)', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('895363929', 'orange'), '0895363929');
        });
        (0, node_test_1.it)('always produces a leading 0 and 10 digits', () => {
            const result = (0, phone_normalization_1.normalizePhoneForOperator)('+243895363929', 'orange');
            strict_1.default.ok(result.startsWith('0'), `Orange MSISDN must start with 0, got: ${result}`);
            strict_1.default.equal(result.length, 10);
        });
    });
    (0, node_test_1.describe)('Afrimoney (provider_id=19) — 10 digits, with leading 0', () => {
        (0, node_test_1.it)('formats E.164 input correctly', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243901030625', 'afrimoney'), '0901030625');
        });
        (0, node_test_1.it)('formats local-with-0 input correctly (keeps the 0)', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0901030625', 'afrimoney'), '0901030625');
        });
        (0, node_test_1.it)('formats bare 9-digit input correctly (adds the 0)', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('901030625', 'afrimoney'), '0901030625');
        });
        (0, node_test_1.it)('always produces a leading 0 and 10 digits', () => {
            const result = (0, phone_normalization_1.normalizePhoneForOperator)('+243901030625', 'afrimoney');
            strict_1.default.ok(result.startsWith('0'), `Afrimoney MSISDN must start with 0, got: ${result}`);
            strict_1.default.equal(result.length, 10);
        });
    });
    (0, node_test_1.describe)('Africell (provider_id=19) — same as Afrimoney', () => {
        (0, node_test_1.it)('formats correctly with leading 0', () => {
            strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243901030625', 'africell'), '0901030625');
        });
    });
    (0, node_test_1.describe)('cross-operator: same phone, different formats', () => {
        (0, node_test_1.it)('Airtel number 998338854 sent on Airtel → 998338854 (9 digits)', () => {
            const result = (0, phone_normalization_1.normalizePhoneForOperator)('+243998338854', 'airtel');
            strict_1.default.equal(result, '998338854');
            strict_1.default.equal(result.length, 9);
        });
        (0, node_test_1.it)('Airtel number 998338854 sent on Orange → 0998338854 (10 digits, correct FORMAT but wrong OPERATOR)', () => {
            // This is the scenario from transaction don_1789022428_1:
            // phone +243998338854 (Airtel prefix 99) sent on Orange channel.
            // Our code correctly formats it as 0998338854 (10 digits with 0),
            // but Unipesa/Orange rejects it with MSISDN INCORRECT because
            // the number doesn't belong to Orange's network.
            const result = (0, phone_normalization_1.normalizePhoneForOperator)('+243998338854', 'orange');
            strict_1.default.equal(result, '0998338854');
            strict_1.default.equal(result.length, 10);
            strict_1.default.ok(result.startsWith('0'));
        });
    });
    (0, node_test_1.describe)('extractLocalDigits', () => {
        (0, node_test_1.it)('extracts 9 digits from E.164', () => {
            strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243970967029'), '970967029');
        });
        (0, node_test_1.it)('extracts 9 digits from local with 0', () => {
            strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('0970967029'), '970967029');
        });
        (0, node_test_1.it)('extracts 9 digits from bare local', () => {
            strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('970967029'), '970967029');
        });
        (0, node_test_1.it)('returns null for invalid input', () => {
            strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('123'), null);
            strict_1.default.equal((0, phone_normalization_1.extractLocalDigits)('+243123'), null);
        });
    });
    (0, node_test_1.describe)('avada.ts uses formatPhoneForOperator for outgoing', () => {
        // Static check: the initiateCollection function in avada.ts
        // must use formatPhoneForOperator, not normalizePhone directly.
        const fs = require('fs');
        const path = require('path');
        const avada = fs.readFileSync(path.resolve(process.cwd(), 'src/services/avada.ts'), 'utf8');
        (0, node_test_1.it)('imports normalizePhoneForOperator', () => {
            strict_1.default.match(avada, /from '\.\.\/lib\/phone-normalization'/);
        });
        (0, node_test_1.it)('defines formatPhoneForOperator that delegates to normalizePhoneForOperator', () => {
            strict_1.default.match(avada, /function formatPhoneForOperator/);
            strict_1.default.match(avada, /normalizePhoneForOperator/);
        });
        (0, node_test_1.it)('initiateCollection uses formatPhoneForOperator for customer_id', () => {
            strict_1.default.match(avada, /customer_id:\s*formatPhoneForOperator\(phone, operator\)/);
        });
        (0, node_test_1.it)('initiatePayout uses formatPhoneForOperator for customer_id', () => {
            strict_1.default.match(avada, /customer_id:\s*formatPhoneForOperator\(phone, operator\)/);
        });
    });
});
//# sourceMappingURL=phone-format-outgoing.test.js.map