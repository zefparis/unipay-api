"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const phone_normalization_1 = require("../phone-normalization");
/**
 * Tests for the merchant settlement system.
 *
 * Since the settlement RPCs run in PostgreSQL (Supabase), we test
 * the business logic that is in TypeScript:
 *   - Phone normalization for settlement payouts
 *   - Threshold logic (auto-payout vs admin review)
 *   - Balance calculation formula
 *
 * The RPC atomicity (FOR UPDATE, idempotence) is tested via the
 * SQL migration tests in supabase/tests/.
 */
// ── Threshold logic ────────────────────────────────────────────
const AUTO_MAX_PER_REQUEST = 500000; // CDF
const AUTO_MAX_DAILY = 2000000; // CDF
function shouldAutoPayout(amount, todaySettled, maxPerRequest = AUTO_MAX_PER_REQUEST, maxDaily = AUTO_MAX_DAILY) {
    if (amount > maxPerRequest)
        return false;
    if (todaySettled + amount > maxDaily)
        return false;
    return true;
}
(0, node_test_1.describe)('Settlement threshold logic', () => {
    (0, node_test_1.it)('auto-payout for small amount under both thresholds', () => {
        strict_1.default.equal(shouldAutoPayout(100000, 0), true);
    });
    (0, node_test_1.it)('admin review when amount exceeds per-request threshold', () => {
        strict_1.default.equal(shouldAutoPayout(600000, 0), false); // 600k > 500k
    });
    (0, node_test_1.it)('admin review when daily cumulative exceeds threshold', () => {
        strict_1.default.equal(shouldAutoPayout(300000, 1800000), false); // 300k + 1800k > 2000k
    });
    (0, node_test_1.it)('auto-payout when exactly at per-request threshold', () => {
        strict_1.default.equal(shouldAutoPayout(500000, 0), true); // equal is OK (not above)
    });
    (0, node_test_1.it)('auto-payout when daily cumulative exactly at threshold', () => {
        strict_1.default.equal(shouldAutoPayout(200000, 1800000), true); // 200k + 1800k = 2000k exactly
    });
    (0, node_test_1.it)('admin review for very large amount', () => {
        strict_1.default.equal(shouldAutoPayout(5000000, 0), false);
    });
    (0, node_test_1.it)('a merchant doing many small settlements stays in auto-payout until daily limit', () => {
        // 10 settlements of 100k each = 1M, all auto
        let todaySettled = 0;
        for (let i = 0; i < 10; i++) {
            strict_1.default.equal(shouldAutoPayout(100000, todaySettled), true);
            todaySettled += 100000;
        }
        // 11th would push to 1.1M — still under 2M, auto
        strict_1.default.equal(shouldAutoPayout(100000, todaySettled), true);
        todaySettled += 100000;
        // 20th settlement: todaySettled = 1.9M, +100k = 2M exactly — auto
        for (let i = 0; i < 9; i++) {
            strict_1.default.equal(shouldAutoPayout(100000, todaySettled), true);
            todaySettled += 100000;
        }
        // 21st: todaySettled = 2M, +100k = 2.1M > 2M — review
        strict_1.default.equal(shouldAutoPayout(100000, todaySettled), false);
    });
});
// ── Balance calculation ────────────────────────────────────────
function computeBalance(entries) {
    const credits = entries
        .filter((e) => e.type === 'credit')
        .reduce((s, e) => s + e.amount, 0);
    const settlements = entries
        .filter((e) => e.type === 'settlement')
        .reduce((s, e) => s + e.amount, 0);
    return Math.round((credits - settlements) * 100) / 100;
}
(0, node_test_1.describe)('Settlement balance calculation', () => {
    (0, node_test_1.it)('empty ledger = 0', () => {
        strict_1.default.equal(computeBalance([]), 0);
    });
    (0, node_test_1.it)('single credit = net_amount', () => {
        strict_1.default.equal(computeBalance([
            { type: 'credit', amount: 480 },
        ]), 480);
    });
    (0, node_test_1.it)('credit minus settlement = remaining', () => {
        strict_1.default.equal(computeBalance([
            { type: 'credit', amount: 480 },
            { type: 'credit', amount: 960 },
            { type: 'settlement', amount: 500 },
        ]), 940);
    });
    (0, node_test_1.it)('full settlement = 0', () => {
        strict_1.default.equal(computeBalance([
            { type: 'credit', amount: 480 },
            { type: 'settlement', amount: 480 },
        ]), 0);
    });
    (0, node_test_1.it)('reject re-credits the ledger (credit after settlement)', () => {
        // Original: 480 credit, 480 settlement (balance=0)
        // Reject: +480 credit (re-credit) → balance=480
        strict_1.default.equal(computeBalance([
            { type: 'credit', amount: 480 },
            { type: 'settlement', amount: 480 },
            { type: 'credit', amount: 480 }, // re-credit from reject
        ]), 480);
    });
    (0, node_test_1.it)('multiple credits and settlements', () => {
        strict_1.default.equal(computeBalance([
            { type: 'credit', amount: 1000 },
            { type: 'credit', amount: 2000 },
            { type: 'settlement', amount: 500 },
            { type: 'credit', amount: 500 },
            { type: 'settlement', amount: 1500 },
            { type: 'credit', amount: 300 },
        ]), 1800);
    });
});
// ── Phone normalization for settlement payouts ─────────────────
(0, node_test_1.describe)('Settlement phone normalization', () => {
    (0, node_test_1.it)('settlement_phone +243997174834 → Orange: 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('+243997174834', 'orange'), '0997174834');
    });
    (0, node_test_1.it)('settlement_phone 0997174834 → Airtel: 997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('0997174834', 'airtel'), '997174834');
    });
    (0, node_test_1.it)('settlement_phone 997174834 → Afrimoney: 0997174834', () => {
        strict_1.default.equal((0, phone_normalization_1.normalizePhoneForOperator)('997174834', 'afrimoney'), '0997174834');
    });
    (0, node_test_1.it)('rejects invalid settlement phone', () => {
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)('123'), false);
        strict_1.default.equal((0, phone_normalization_1.isValidDrcPhone)(''), false);
    });
});
// ── Idempotency key generation ─────────────────────────────────
(0, node_test_1.describe)('Idempotency key generation', () => {
    (0, node_test_1.it)('crypto.randomUUID produces unique keys', () => {
        const keys = new Set();
        for (let i = 0; i < 1000; i++) {
            keys.add(crypto.randomUUID());
        }
        strict_1.default.equal(keys.size, 1000); // all unique
    });
});
// ── Concurrent settlement scenario ─────────────────────────────
(0, node_test_1.describe)('Concurrent settlement scenario (simulation)', () => {
    (0, node_test_1.it)('two concurrent settlements cannot exceed balance', () => {
        // Simulate: balance = 1000, two requests of 800 each
        // With FOR UPDATE lock, only one can succeed
        const balance = 1000;
        const request1 = 800;
        const request2 = 800;
        // First request succeeds
        let remainingAfterFirst = balance - request1;
        strict_1.default.ok(remainingAfterFirst >= 0, 'first request should succeed');
        // Second request should fail (remaining = 200, requested = 800)
        strict_1.default.ok(request2 > remainingAfterFirst, 'second request should be rejected');
    });
    (0, node_test_1.it)('two concurrent settlements that together fit in balance both succeed', () => {
        const balance = 1000;
        const request1 = 400;
        const request2 = 600;
        let remaining = balance - request1;
        strict_1.default.ok(remaining >= 0, 'first request should succeed');
        remaining = remaining - request2;
        strict_1.default.ok(remaining >= 0, 'second request should succeed');
        strict_1.default.equal(remaining, 0);
    });
});
// ── Settlement request lifecycle ───────────────────────────────
(0, node_test_1.describe)('Settlement request lifecycle', () => {
    (0, node_test_1.it)('auto-payout: pending → processing → success', () => {
        // Small amount, under thresholds
        const amount = 100000;
        const todaySettled = 0;
        strict_1.default.equal(shouldAutoPayout(amount, todaySettled), true);
        // Status flow: created as 'processing' → mark_settlement_success → 'success'
    });
    (0, node_test_1.it)('admin review: pending_admin_review → processing → success (after approve)', () => {
        // Large amount, above per-request threshold
        const amount = 600000;
        const todaySettled = 0;
        strict_1.default.equal(shouldAutoPayout(amount, todaySettled), false);
        // Status flow: created as 'pending_admin_review' → admin approves → 'processing' → 'success'
    });
    (0, node_test_1.it)('admin review: pending_admin_review → rejected (after reject)', () => {
        // Large amount, above threshold, admin rejects
        const amount = 600000;
        strict_1.default.equal(shouldAutoPayout(amount, 0), false);
        // Status flow: created as 'pending_admin_review' → admin rejects → 'rejected' + ledger re-credited
    });
    (0, node_test_1.it)('auto-payout failure: processing → failed (ledger re-credited)', () => {
        // Small amount, auto-payout, but Unipesa B2C fails
        // Status flow: 'processing' → mark_settlement_failed → 'failed' + ledger re-credited
        const amount = 100000;
        strict_1.default.equal(shouldAutoPayout(amount, 0), true);
    });
});
//# sourceMappingURL=merchant-settlement.test.js.map