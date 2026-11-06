"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tests for phone-operator prefix matching.
 *
 * Validates that detectOperatorFromPhone and validatePhoneOperatorMatch
 * correctly identify the operator from a DRC phone number's prefix and
 * detect mismatches that would cause Unipesa B2C rejection (MSISDN
 * INCORRECT, code 10401).
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const phone_normalization_1 = require("../phone-normalization");
(0, node_test_1.describe)('detectOperatorFromPhone', () => {
    (0, node_test_1.it)('detects Airtel from prefix 97', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243970967029'), 'airtel');
    });
    (0, node_test_1.it)('detects Airtel from prefix 98', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243981234567'), 'airtel');
    });
    (0, node_test_1.it)('detects Airtel from prefix 99', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243998338854'), 'airtel');
    });
    (0, node_test_1.it)('detects Orange from prefix 84', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243841234567'), 'orange');
    });
    (0, node_test_1.it)('detects Orange from prefix 88', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243881234567'), 'orange');
    });
    (0, node_test_1.it)('detects Orange from prefix 89', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243895363929'), 'orange');
    });
    (0, node_test_1.it)('detects Afrimoney from prefix 81', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243811234567'), 'afrimoney');
    });
    (0, node_test_1.it)('detects Afrimoney from prefix 82', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243821234567'), 'afrimoney');
    });
    (0, node_test_1.it)('detects Afrimoney from prefix 85', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243851234567'), 'afrimoney');
    });
    (0, node_test_1.it)('detects Afrimoney from prefix 90', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243901030625'), 'afrimoney');
    });
    (0, node_test_1.it)('returns null for unknown prefix', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('+243501234567'), null);
    });
    (0, node_test_1.it)('returns null for invalid phone', () => {
        strict_1.default.equal((0, phone_normalization_1.detectOperatorFromPhone)('123'), null);
    });
});
(0, node_test_1.describe)('validatePhoneOperatorMatch', () => {
    (0, node_test_1.it)('returns ok=true when Airtel number matches Airtel operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243998338854', 'airtel');
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('returns ok=true when Orange number matches Orange operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243895363929', 'orange');
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('returns ok=true when Afrimoney number matches Afrimoney operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243901030625', 'afrimoney');
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('returns ok=false when Airtel number is used with Orange operator', () => {
        // This is the exact scenario from transaction don_1789022428_1:
        // phone +243998338854 (Airtel prefix 99) sent on Orange channel.
        // Unipesa/Orange rejects with MSISDN INCORRECT.
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243998338854', 'orange');
        strict_1.default.equal(result.ok, false);
        strict_1.default.equal(result.detected, 'airtel');
        strict_1.default.match(result.message, /airtel/i);
        strict_1.default.match(result.message, /orange/i);
    });
    (0, node_test_1.it)('returns ok=false when Orange number is used with Airtel operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243895363929', 'airtel');
        strict_1.default.equal(result.ok, false);
        strict_1.default.equal(result.detected, 'orange');
    });
    (0, node_test_1.it)('returns ok=false when Airtel number is used with Afrimoney operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243998338854', 'afrimoney');
        strict_1.default.equal(result.ok, false);
        strict_1.default.equal(result.detected, 'airtel');
    });
    (0, node_test_1.it)('returns ok=true for unknown prefix (does not block)', () => {
        // Unknown prefixes should not be blocked — we don't want to reject
        // legitimate numbers from new prefix ranges.
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243501234567', 'orange');
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('is case-insensitive on operator', () => {
        const result = (0, phone_normalization_1.validatePhoneOperatorMatch)('+243998338854', 'ORANGE');
        strict_1.default.equal(result.ok, false);
        strict_1.default.equal(result.detected, 'airtel');
    });
});
//# sourceMappingURL=phone-operator-match.test.js.map