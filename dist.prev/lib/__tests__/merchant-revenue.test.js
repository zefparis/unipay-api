"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
/**
 * Tests for the per-merchant revenue calculation logic.
 *
 * The actual route queries Supabase, so we test the calculation
 * formulas that the route applies to the raw transaction data.
 *
 * Rates (since 2026-09-07 fee bump):
 *   AVADA_FEE_RATE = 0.03  (unchanged — Avada's share)
 *   CLIENT_FEE_RATE = 0.05 (5% merchant commission)
 *   MARGIN_RATE = 0.02     (UniPay net margin = 5% − 3%)
 *
 * Identity: avada_cost + net_margin = client_fees = 5% × volume
 * (when stored fee matches the current rate)
 */
const AVADA_FEE_RATE = 0.03;
const CLIENT_FEE_RATE = 0.05;
const MARGIN_RATE = CLIENT_FEE_RATE - AVADA_FEE_RATE; // 0.02
function computeRevenue(txs, merchantNames) {
    const perMerchant = new Map();
    for (const tx of txs) {
        if (!perMerchant.has(tx.merchant_id)) {
            perMerchant.set(tx.merchant_id, {
                merchant_id: tx.merchant_id,
                name: merchantNames.get(tx.merchant_id) ?? 'Unknown',
                transaction_count: 0,
                volume_collected: 0,
                client_fees: 0,
                avada_cost: 0,
                net_margin: 0,
                net_amount_owed: 0,
            });
        }
        const entry = perMerchant.get(tx.merchant_id);
        entry.transaction_count += 1;
        entry.volume_collected += tx.amount;
        entry.client_fees += tx.fee;
        entry.avada_cost += tx.amount * AVADA_FEE_RATE;
        entry.net_margin += tx.amount * MARGIN_RATE;
        entry.net_amount_owed += tx.net_amount;
    }
    return Array.from(perMerchant.values()).map((e) => ({
        ...e,
        volume_collected: Math.round(e.volume_collected * 100) / 100,
        client_fees: Math.round(e.client_fees * 100) / 100,
        avada_cost: Math.round(e.avada_cost * 100) / 100,
        net_margin: Math.round(e.net_margin * 100) / 100,
        net_amount_owed: Math.round(e.net_amount_owed * 100) / 100,
    }));
}
(0, node_test_1.describe)('Per-merchant revenue calculation', () => {
    (0, node_test_1.it)('single merchant, single transaction (5% fee)', () => {
        const txs = [
            { merchant_id: 'm1', amount: 500, fee: 25, net_amount: 475 },
        ];
        const names = new Map([['m1', 'Graciliashop']]);
        const result = computeRevenue(txs, names);
        strict_1.default.equal(result.length, 1);
        strict_1.default.equal(result[0].merchant_id, 'm1');
        strict_1.default.equal(result[0].name, 'Graciliashop');
        strict_1.default.equal(result[0].transaction_count, 1);
        strict_1.default.equal(result[0].volume_collected, 500);
        strict_1.default.equal(result[0].client_fees, 25); // 5% of 500 = 25
        strict_1.default.equal(result[0].avada_cost, 15); // 3% of 500 = 15
        strict_1.default.equal(result[0].net_margin, 10); // 2% of 500 = 10
        strict_1.default.equal(result[0].net_amount_owed, 475); // 500 - 25 = 475
    });
    (0, node_test_1.it)('multiple merchants, multiple transactions', () => {
        const txs = [
            { merchant_id: 'm1', amount: 1000, fee: 50, net_amount: 950 },
            { merchant_id: 'm1', amount: 2000, fee: 100, net_amount: 1900 },
            { merchant_id: 'm2', amount: 500, fee: 25, net_amount: 475 },
        ];
        const names = new Map([['m1', 'Shop A'], ['m2', 'Shop B']]);
        const result = computeRevenue(txs, names);
        strict_1.default.equal(result.length, 2);
        const shopA = result.find((r) => r.merchant_id === 'm1');
        strict_1.default.equal(shopA.transaction_count, 2);
        strict_1.default.equal(shopA.volume_collected, 3000);
        strict_1.default.equal(shopA.client_fees, 150); // 50 + 100
        strict_1.default.equal(shopA.avada_cost, 90); // 3000 × 0.03
        strict_1.default.equal(shopA.net_margin, 60); // 3000 × 0.02
        strict_1.default.equal(shopA.net_amount_owed, 2850); // 950 + 1900
        const shopB = result.find((r) => r.merchant_id === 'm2');
        strict_1.default.equal(shopB.transaction_count, 1);
        strict_1.default.equal(shopB.volume_collected, 500);
        strict_1.default.equal(shopB.net_margin, 10); // 500 × 0.02
    });
    (0, node_test_1.it)('margin is always 2% of volume (not of fee)', () => {
        const txs = [
            { merchant_id: 'm1', amount: 10000, fee: 500, net_amount: 9500 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Test']]));
        // net_margin = amount × 0.02 = 200, NOT fee × 0.40 = 200
        strict_1.default.equal(result[0].net_margin, 200);
        strict_1.default.equal(result[0].avada_cost, 300); // 10000 × 0.03
        strict_1.default.equal(result[0].client_fees, 500); // stored fee
    });
    (0, node_test_1.it)('client_fees uses stored fee, not recalculated 5%', () => {
        // If the stored fee differs from 5% (e.g. an old 4% transaction),
        // the route uses the stored value for client_fees
        const txs = [
            { merchant_id: 'm1', amount: 1000, fee: 40, net_amount: 960 }, // old 4% fee
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Test']]));
        strict_1.default.equal(result[0].client_fees, 40); // uses stored fee
        strict_1.default.equal(result[0].avada_cost, 30); // 3% of amount (constant)
        strict_1.default.equal(result[0].net_margin, 20); // 2% of amount (constant)
    });
    (0, node_test_1.it)('totals aggregation across all merchants', () => {
        const txs = [
            { merchant_id: 'm1', amount: 1000, fee: 50, net_amount: 950 },
            { merchant_id: 'm2', amount: 500, fee: 25, net_amount: 475 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'A'], ['m2', 'B']]));
        const totals = {
            transaction_count: result.reduce((s, e) => s + e.transaction_count, 0),
            volume_collected: result.reduce((s, e) => s + e.volume_collected, 0),
            client_fees: result.reduce((s, e) => s + e.client_fees, 0),
            avada_cost: result.reduce((s, e) => s + e.avada_cost, 0),
            net_margin: result.reduce((s, e) => s + e.net_margin, 0),
            net_amount_owed: result.reduce((s, e) => s + e.net_amount_owed, 0),
        };
        strict_1.default.equal(totals.transaction_count, 2);
        strict_1.default.equal(totals.volume_collected, 1500);
        strict_1.default.equal(totals.client_fees, 75);
        strict_1.default.equal(totals.avada_cost, 45);
        strict_1.default.equal(totals.net_margin, 30); // 1500 × 0.02
        strict_1.default.equal(totals.net_amount_owed, 1425);
    });
    (0, node_test_1.it)('sorting by margin descending', () => {
        const txs = [
            { merchant_id: 'm1', amount: 100, fee: 5, net_amount: 95 },
            { merchant_id: 'm2', amount: 10000, fee: 500, net_amount: 9500 },
            { merchant_id: 'm3', amount: 1000, fee: 50, net_amount: 950 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'A'], ['m2', 'B'], ['m3', 'C']]));
        result.sort((a, b) => b.net_margin - a.net_margin);
        strict_1.default.equal(result[0].merchant_id, 'm2'); // highest margin (200)
        strict_1.default.equal(result[1].merchant_id, 'm3'); // medium margin (20)
        strict_1.default.equal(result[2].merchant_id, 'm1'); // lowest margin (2)
    });
    (0, node_test_1.it)('sorting by volume descending', () => {
        const txs = [
            { merchant_id: 'm1', amount: 100, fee: 5, net_amount: 95 },
            { merchant_id: 'm2', amount: 10000, fee: 500, net_amount: 9500 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'A'], ['m2', 'B']]));
        result.sort((a, b) => b.volume_collected - a.volume_collected);
        strict_1.default.equal(result[0].merchant_id, 'm2');
        strict_1.default.equal(result[1].merchant_id, 'm1');
    });
    (0, node_test_1.it)('sorting by transaction count descending', () => {
        const txs = [
            { merchant_id: 'm1', amount: 100, fee: 5, net_amount: 95 },
            { merchant_id: 'm1', amount: 100, fee: 5, net_amount: 95 },
            { merchant_id: 'm1', amount: 100, fee: 5, net_amount: 95 },
            { merchant_id: 'm2', amount: 50000, fee: 2500, net_amount: 47500 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'A'], ['m2', 'B']]));
        result.sort((a, b) => b.transaction_count - a.transaction_count);
        strict_1.default.equal(result[0].merchant_id, 'm1'); // 3 txs
        strict_1.default.equal(result[1].merchant_id, 'm2'); // 1 tx
    });
    (0, node_test_1.it)('merchant with no transactions is not included', () => {
        const result = computeRevenue([], new Map([['m1', 'Ghost']]));
        strict_1.default.equal(result.length, 0);
    });
    (0, node_test_1.it)('consistency: net_margin = client_fees - avada_cost when fee = 5%', () => {
        // When the stored fee is exactly 5% (the current rate):
        // client_fees = amount × 0.05
        // avada_cost = amount × 0.03
        // net_margin = amount × 0.02 = client_fees - avada_cost
        const txs = [
            { merchant_id: 'm1', amount: 1000, fee: 50, net_amount: 950 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Test']]));
        strict_1.default.equal(result[0].net_margin, result[0].client_fees - result[0].avada_cost);
    });
    (0, node_test_1.it)('consistency: net_amount_owed = volume - client_fees (when fee = 5%)', () => {
        const txs = [
            { merchant_id: 'm1', amount: 1000, fee: 50, net_amount: 950 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Test']]));
        strict_1.default.equal(result[0].net_amount_owed, result[0].volume_collected - result[0].client_fees);
    });
    (0, node_test_1.it)('accounting identity: avada_cost + net_margin = client_fees = 5% of volume', () => {
        // The core accounting identity:
        //   avada_cost (3%) + net_margin (2%) = client_fees (5%) = volume × 5%
        const txs = [
            { merchant_id: 'm1', amount: 5000, fee: 250, net_amount: 4750 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Test']]));
        const r = result[0];
        // Use rounding to avoid floating-point precision issues (0.05 × 5000 = 250.00000000000003)
        strict_1.default.equal(Math.round(r.avada_cost + r.net_margin), Math.round(r.client_fees));
        strict_1.default.equal(Math.round(r.client_fees), Math.round(r.volume_collected * CLIENT_FEE_RATE));
        strict_1.default.equal(Math.round(r.avada_cost), Math.round(r.volume_collected * AVADA_FEE_RATE));
        strict_1.default.equal(Math.round(r.net_margin), Math.round(r.volume_collected * MARGIN_RATE));
        // Concrete: 5000 × 0.03 = 150, 5000 × 0.02 = 100, 150 + 100 = 250 ✓
        strict_1.default.equal(r.avada_cost, 150);
        strict_1.default.equal(r.net_margin, 100);
        strict_1.default.equal(r.client_fees, 250);
    });
    (0, node_test_1.it)('CSV export format', () => {
        const txs = [
            { merchant_id: 'm1', amount: 500, fee: 25, net_amount: 475 },
        ];
        const result = computeRevenue(txs, new Map([['m1', 'Graciliashop']]));
        const headers = ['merchant_id', 'name', 'transaction_count', 'volume_collected', 'client_fees', 'avada_cost', 'net_margin', 'net_amount_owed'];
        const csvLine = [
            result[0].merchant_id,
            `"${result[0].name}"`,
            result[0].transaction_count,
            result[0].volume_collected,
            result[0].client_fees,
            result[0].avada_cost,
            result[0].net_margin,
            result[0].net_amount_owed,
        ].join(',');
        strict_1.default.equal(headers.length, 8);
        strict_1.default.ok(csvLine.includes('Graciliashop'));
        strict_1.default.ok(csvLine.includes('500'));
        strict_1.default.ok(csvLine.includes('10')); // net_margin = 500 × 0.02 = 10
    });
});
//# sourceMappingURL=merchant-revenue.test.js.map