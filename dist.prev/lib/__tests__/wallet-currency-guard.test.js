"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Wallet CDF path hardening (review 2026-09-29):
 *   (a) POST /v1/wallet/withdraw and /v1/wallet/deposit reject currency != 'CDF'
 *       — Fastify returns 400 on enum violation before any provider call.
 *       Proven risk: request.currency flowed verbatim into the Unipesa
 *       payload while wallet_debit_with_kyc_limit always debits balance_cdf.
 *   (b) the 502 response no longer leaks provider internals via `detail`.
 *   (c) admin revenue metrics read AVADA_FEE_RATE / MERCHANT_FEE_RATE from env.
 */
const SRC = node_path_1.default.resolve(__dirname, '../../../src');
const WITHDRAW = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/withdraw.ts'), 'utf-8');
const DEPOSIT = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/wallet/deposit.ts'), 'utf-8');
const MERCHANTS = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/admin/merchants.ts'), 'utf-8');
// ── (a) currency enum guard ──────────────────────────────────
(0, node_test_1.describe)('currency guard — CDF only', () => {
    (0, node_test_1.it)('withdraw schema pins currency to enum ["CDF"]', () => {
        strict_1.default.match(WITHDRAW, /currency:\s*\{\s*type:\s*'string',\s*enum:\s*\['CDF'\],\s*default:\s*'CDF'\s*\}/);
    });
    (0, node_test_1.it)('deposit schema pins currency to enum ["CDF"]', () => {
        strict_1.default.match(DEPOSIT, /currency:\s*\{\s*type:\s*'string',\s*enum:\s*\['CDF'\],\s*default:\s*'CDF'\s*\}/);
    });
    (0, node_test_1.it)('withdraw schema has no unconstrained currency length fallback', () => {
        strict_1.default.doesNotMatch(WITHDRAW, /currency:\s*\{[^}]*minLength/);
    });
});
// ── (b) no provider internals in the 502 body ────────────────
(0, node_test_1.describe)('withdraw 502 — no provider detail leak', () => {
    (0, node_test_1.it)('does not send errMsg/detail to the client', () => {
        const reply502 = WITHDRAW.match(/reply\.status\(502\)\.send\(\{[\s\S]*?\}\)/);
        strict_1.default.ok(reply502, 'expected a 502 reply block');
        strict_1.default.doesNotMatch(reply502[0], /detail|errMsg/);
    });
    (0, node_test_1.it)('still logs the full provider error server-side (both refund and ambiguous paths)', () => {
        const logs = WITHDRAW.match(/log\.error\(\s*\{ err: errMsg[^}]*\}/g) ?? [];
        strict_1.default.ok(logs.length >= 2, `expected errMsg logged on both provider-failure paths, found ${logs.length}`);
    });
});
// ── (c) admin revenue rates come from env ────────────────────
(0, node_test_1.describe)('admin merchants — env-driven rates', () => {
    (0, node_test_1.it)('AVADA_FEE_RATE reads env.AVADA_FEE_RATE', () => {
        strict_1.default.match(MERCHANTS, /AVADA_FEE_RATE\s*=\s*Number\(env\.AVADA_FEE_RATE\)/);
    });
    (0, node_test_1.it)('CLIENT_FEE_RATE reads env.MERCHANT_FEE_RATE', () => {
        strict_1.default.match(MERCHANTS, /CLIENT_FEE_RATE\s*=\s*Number\(env\.MERCHANT_FEE_RATE\)/);
    });
    (0, node_test_1.it)('no hardcoded fee-rate literal remains in revenue computation', () => {
        strict_1.default.doesNotMatch(MERCHANTS, /AVADA_FEE_RATE\s*=\s*0\.03/);
    });
});
//# sourceMappingURL=wallet-currency-guard.test.js.map