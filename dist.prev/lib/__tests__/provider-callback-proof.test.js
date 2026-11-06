"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const provider_callback_proof_js_1 = require("../provider-callback-proof.js");
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
(0, node_test_1.describe)('provider callback proof', () => {
    (0, node_test_1.it)('accepts a callback matching the stored transaction', () => {
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(validCallback, transaction), { valid: true });
    });
    (0, node_test_1.it)('rejects a signed callback with a different amount', () => {
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)({ ...validCallback, amount: 1 }, transaction), { valid: false, reason: 'AMOUNT_MISMATCH' });
    });
    (0, node_test_1.it)('rejects mismatched reference, phone, operator, and currency', () => {
        strict_1.default.equal((0, provider_callback_proof_js_1.validateProviderCallbackProof)({ ...validCallback, reference: 'WD-OTHER' }, transaction).valid, false);
        strict_1.default.equal((0, provider_callback_proof_js_1.validateProviderCallbackProof)({ ...validCallback, phone: '+243811111111' }, transaction).valid, false);
        strict_1.default.equal((0, provider_callback_proof_js_1.validateProviderCallbackProof)({ ...validCallback, operator: 'airtel' }, transaction).valid, false);
        strict_1.default.equal((0, provider_callback_proof_js_1.validateProviderCallbackProof)({ ...validCallback, currency: 'USD' }, transaction).valid, false);
    });
    (0, node_test_1.it)('accepts a callback where phone lacks the country code (real Unipesa format)', () => {
        // Unipesa sends customer_id as "970967029" (no +243 prefix);
        // DB stores "+243970967029". These must match.
        const callback = { ...validCallback, phone: '970967029' };
        const tx = { ...transaction, phone: '+243970967029' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('accepts Airtel callback: DB E.164 vs callback local 9-digit', () => {
        // Airtel: callback sends "970967029" (9 digits, no prefix, no leading 0)
        const callback = { ...validCallback, phone: '970967029', operator: 'airtel' };
        const tx = { ...transaction, phone: '+243970967029', operator: 'airtel' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('accepts Orange callback: DB E.164 vs callback local 10-digit with leading 0', () => {
        // Orange: callback sends "0895363929" (10 digits, with leading 0)
        // DB stores "+243895363929" (E.164)
        const callback = { ...validCallback, phone: '0895363929', operator: 'orange' };
        const tx = { ...transaction, phone: '+243895363929', operator: 'orange' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('accepts Africell callback: DB E.164 vs callback local 10-digit with leading 0', () => {
        // Africell: callback sends "0901030625" (10 digits, with leading 0)
        // DB stores "+243901030625" (E.164)
        const callback = { ...validCallback, phone: '0901030625', operator: 'afrimoney' };
        const tx = { ...transaction, phone: '+243901030625', operator: 'afrimoney' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('accepts DB stored in local format (no +243) matching callback', () => {
        // DB sometimes stores local format without +243 (e.g. "997174834")
        const callback = { ...validCallback, phone: '997174834' };
        const tx = { ...transaction, phone: '997174834' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('accepts DB stored with leading 0 matching callback with leading 0', () => {
        // DB sometimes stores Orange local format "0895363929"
        const callback = { ...validCallback, phone: '0895363929', operator: 'orange' };
        const tx = { ...transaction, phone: '0895363929', operator: 'orange' };
        strict_1.default.deepEqual((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx), { valid: true });
    });
    (0, node_test_1.it)('rejects a genuinely different phone even with country-code normalization', () => {
        const callback = { ...validCallback, phone: '970967029' };
        const tx = { ...transaction, phone: '+243811111111' };
        strict_1.default.equal((0, provider_callback_proof_js_1.validateProviderCallbackProof)(callback, tx).valid, false);
    });
    (0, node_test_1.it)('requires the route to reject an absent signature unconditionally', () => {
        const source = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/routes/payment/callback.ts'), 'utf8');
        strict_1.default.match(source, /if \(!request\.body\?\.signature \|\| !verifyCallbackSignature/);
        strict_1.default.doesNotMatch(source, /'signature' in request\.body/);
    });
});
//# sourceMappingURL=provider-callback-proof.test.js.map