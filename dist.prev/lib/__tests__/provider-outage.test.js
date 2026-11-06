"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tests for the shared provider-outage classification logic.
 *
 * This function is used by both:
 *   - GET /v1/status/operators (public operator health)
 *   - GET /v1/admin/merchants/:id/stats (per-merchant success/failure stats)
 *
 * Verifies that provider-outage failures (upstream API unreachable, token
 * errors, codes 10301/10201) are correctly distinguished from client errors
 * (insufficient balance, wrong MSISDN, etc.).
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const provider_outage_js_1 = require("../provider-outage.js");
(0, node_test_1.describe)('isProviderOutageFailure', () => {
    (0, node_test_1.it)('returns false for null metadata', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)(null), false);
    });
    (0, node_test_1.it)('returns false for empty metadata', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({}), false);
    });
    (0, node_test_1.it)('returns false for client errors (insufficient balance)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'Insufficient balance' }), false);
    });
    (0, node_test_1.it)('returns false for client errors (wrong MSISDN)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'MSISDN INCORRECT' }), false);
    });
    (0, node_test_1.it)('detects unipesa_result_code 10301 (reconciliation)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ unipesa_result_code: 10301 }), true);
    });
    (0, node_test_1.it)('detects unipesa_result_code 10201 (reconciliation)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ unipesa_result_code: 10201 }), true);
    });
    (0, node_test_1.it)('does not flag non-outage result codes', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ unipesa_result_code: 200 }), false);
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ unipesa_result_code: 0 }), false);
    });
    (0, node_test_1.it)('detects result.code 10301 (callback)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ result: { code: 10301 } }), true);
    });
    (0, node_test_1.it)('detects result.code 10201 (callback)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ result: { code: 10201 } }), true);
    });
    (0, node_test_1.it)('does not flag result.code for non-outage codes', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ result: { code: 200 } }), false);
    });
    (0, node_test_1.it)('detects "API unreachable" in reason', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'Airtel API unreachable' }), true);
    });
    (0, node_test_1.it)('detects "get token error" in reason', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'get token error from provider' }), true);
    });
    (0, node_test_1.it)('detects "provider unavailable" in reason (case-insensitive)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'Provider temporarily unavailable' }), true);
    });
    (0, node_test_1.it)('does not flag unrelated reason strings', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'Transaction cancelled by user' }), false);
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ reason: 'Invalid phone number' }), false);
    });
    (0, node_test_1.it)('handles string unipesa_result_code gracefully (not a number)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ unipesa_result_code: '10301' }), false);
    });
    (0, node_test_1.it)('handles result.code as string gracefully (not a number)', () => {
        strict_1.default.equal((0, provider_outage_js_1.isProviderOutageFailure)({ result: { code: '10301' } }), false);
    });
});
//# sourceMappingURL=provider-outage.test.js.map