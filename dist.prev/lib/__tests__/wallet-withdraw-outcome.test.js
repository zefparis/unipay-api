"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Money-safety decisions of the wallet withdrawal route (pure functions).
 *
 * The single most important property: ONLY provably-rejected provider
 * outcomes are 'definitive' (→ synchronous refund). Everything else is
 * 'ambiguous' (→ no refund, reconciliation decides).
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const wallet_withdraw_outcome_1 = require("../wallet-withdraw-outcome");
(0, node_test_1.describe)('DEFINITIVE_REJECT_CODES', () => {
    (0, node_test_1.it)('contains exactly the two proven rejection codes', () => {
        strict_1.default.deepEqual([...wallet_withdraw_outcome_1.DEFINITIVE_REJECT_CODES].sort(), [10105, 10401]);
    });
    (0, node_test_1.it)('does NOT contain outage-looking codes without proof (10201, 10301)', () => {
        strict_1.default.equal(wallet_withdraw_outcome_1.DEFINITIVE_REJECT_CODES.has(10201), false);
        strict_1.default.equal(wallet_withdraw_outcome_1.DEFINITIVE_REJECT_CODES.has(10301), false);
    });
});
(0, node_test_1.describe)('classifyPayoutFailure — definitive', () => {
    (0, node_test_1.it)('10105 WRONG MERCHANT_ID → definitive', () => {
        const r = (0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'));
        strict_1.default.deepEqual(r, { kind: 'definitive', code: 10105, reason: 'provider_rejected_10105' });
    });
    (0, node_test_1.it)('10401 MSISDN INCORRECT → definitive', () => {
        const r = (0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error('Unipesa provider error: code=10401 message=MSISDN INCORRECT'));
        strict_1.default.equal(r.kind, 'definitive');
        strict_1.default.equal(r.code, 10401);
    });
    (0, node_test_1.it)('FIXIE_PROXY_REQUIRED (thrown before any network call) → definitive', () => {
        const r = (0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error('FIXIE_PROXY_REQUIRED: FIXIE_URL is not set'));
        strict_1.default.deepEqual(r, { kind: 'definitive', reason: 'pre_network_failure' });
    });
    (0, node_test_1.it)('Unknown operator (thrown before any network call) → definitive', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error('Unknown operator: Foo')).kind, 'definitive');
    });
});
(0, node_test_1.describe)('classifyPayoutFailure — ambiguous', () => {
    const AMBIGUOUS = [
        ['unknown result.code', 'Unipesa provider error: code=99999 message=whatever'],
        ['10301 get token error', 'Unipesa provider error: code=10301 message=REQUEST SENDING ERROR | get token error'],
        ['10201', 'Unipesa provider error: code=10201 message=x'],
        ['timeout (AbortSignal)', 'The operation was aborted due to timeout'],
        ['TimeoutError name only', 'TimeoutError'],
        ['fetch failed', 'fetch failed'],
        ['ECONNRESET', 'read ECONNRESET'],
        ['ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443'],
        ['HTTP 502', 'Unipesa HTTP 502: <html>Bad Gateway</html>'],
        ['HTTP 403 (gateway)', 'Unipesa HTTP 403: Forbidden'],
        ['non-JSON body', 'Unipesa non-JSON response: <html>'],
        ['OK but no transaction_id', 'Unipesa provider did not create a transaction: An unexpected error occurred'],
        ['empty message', ''],
    ];
    for (const [label, msg] of AMBIGUOUS) {
        (0, node_test_1.it)(`${label} → ambiguous`, () => {
            strict_1.default.equal((0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error(msg)).kind, 'ambiguous');
        });
    }
    (0, node_test_1.it)('non-Error input → ambiguous', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.classifyPayoutFailure)('boom').kind, 'ambiguous');
        strict_1.default.equal((0, wallet_withdraw_outcome_1.classifyPayoutFailure)(undefined).kind, 'ambiguous');
    });
    (0, node_test_1.it)('unknown code is reported for logging', () => {
        const r = (0, wallet_withdraw_outcome_1.classifyPayoutFailure)(new Error('Unipesa provider error: code=13104 message=x'));
        strict_1.default.equal(r.kind, 'ambiguous');
        strict_1.default.equal(r.code, 13104);
    });
});
(0, node_test_1.describe)('mapClaimError', () => {
    (0, node_test_1.it)('IDEMPOTENCY_KEY_REUSED → 422', () => {
        strict_1.default.deepEqual((0, wallet_withdraw_outcome_1.mapClaimError)('IDEMPOTENCY_KEY_REUSED'), { status: 422, error: 'IDEMPOTENCY_KEY_REUSED' });
    });
    (0, node_test_1.it)('INSUFFICIENT_FUNDS → 402 (unchanged)', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.mapClaimError)('INSUFFICIENT_FUNDS: balance 50, required 105')?.status, 402);
    });
    (0, node_test_1.it)('KYC_LIMIT_EXCEEDED → 403 (unchanged)', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.mapClaimError)('KYC_LIMIT_EXCEEDED: daily_used 0, requested 105, limit 100')?.status, 403);
    });
    (0, node_test_1.it)('WALLET_SUSPENDED → 403', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.mapClaimError)('WALLET_SUSPENDED')?.status, 403);
    });
    for (const code of ['INVALID_TOTAL', 'INVALID_AMOUNT: amount must be > 0', 'INVALID_FEE: fee must be >= 0', 'UNSUPPORTED_WALLET_CURRENCY']) {
        (0, node_test_1.it)(`${code.split(':')[0]} → 400`, () => {
            const m = (0, wallet_withdraw_outcome_1.mapClaimError)(code);
            strict_1.default.equal(m?.status, 400);
            strict_1.default.equal(m?.error, code.split(':')[0]);
        });
    }
    (0, node_test_1.it)('unknown → null (route answers 500)', () => {
        strict_1.default.equal((0, wallet_withdraw_outcome_1.mapClaimError)('something else'), null);
    });
});
(0, node_test_1.describe)('replayStatusCode', () => {
    for (const s of ['pending', 'processing', 'success']) {
        (0, node_test_1.it)(`${s} → 201`, () => strict_1.default.equal((0, wallet_withdraw_outcome_1.replayStatusCode)(s), 201));
    }
    for (const s of ['failed', 'cancelled']) {
        (0, node_test_1.it)(`${s} → 409`, () => strict_1.default.equal((0, wallet_withdraw_outcome_1.replayStatusCode)(s), 409));
    }
});
//# sourceMappingURL=wallet-withdraw-outcome.test.js.map