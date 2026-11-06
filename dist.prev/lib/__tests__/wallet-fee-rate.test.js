"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Wallet fee rate — parity with the front-end.
 *
 * The expectations below mirror unipay-app/tests/fees.test.ts.
 * If one side changes, the other must change too.
 *
 * env.ts exits the process when required vars are missing — stub
 * them before importing wallet-fees (which imports env).
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';
// Assert the DEFAULT: ignore any local .env override.
delete process.env.WALLET_FEE_RATE;
// require() (not a static import) so the env stubs above run before
// env.ts is evaluated.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WALLET_FEE_RATE, walletFee } = require('../wallet-fees');
// Withdraw model: fee ADDED → debited = amount + fee, received = amount.
// Deposit model: fee DEDUCTED → credited = amount − fee.
const withdrawTotal = (amount) => Math.round((amount + walletFee(amount)) * 100) / 100;
const depositNet = (amount) => Math.round((amount - walletFee(amount)) * 100) / 100;
(0, node_test_1.describe)('wallet fee rate (api)', () => {
    (0, node_test_1.it)('defaults to 5% when WALLET_FEE_RATE is unset', () => {
        strict_1.default.equal(WALLET_FEE_RATE, 0.05);
    });
    const CASES = [
        // amount, fee, withdraw total debited, deposit net credited
        [100, 5, 105, 95],
        [250, 12.5, 262.5, 237.5],
        [500, 25, 525, 475],
        [1, 0.05, 1.05, 0.95],
        [10, 0.5, 10.5, 9.5],
    ];
    for (const [amount, expectedFee, expectedTotal, expectedNet] of CASES) {
        (0, node_test_1.it)(`amount ${amount} → fee ${expectedFee}, debited ${expectedTotal}, deposit net ${expectedNet}`, () => {
            strict_1.default.equal(walletFee(amount), expectedFee);
            strict_1.default.equal(withdrawTotal(amount), expectedTotal);
            strict_1.default.equal(depositNet(amount), expectedNet);
        });
    }
    (0, node_test_1.it)('fee never rounds to zero within allowed minimums', () => {
        strict_1.default.ok(walletFee(100) > 0); // CDF min withdraw
        strict_1.default.ok(walletFee(1) > 0); // USD min
    });
});
//# sourceMappingURL=wallet-fee-rate.test.js.map