/**
 * Wallet fee rate — parity with the front-end.
 *
 * The expectations below mirror unipay-app/tests/fees.test.ts.
 * If one side changes, the other must change too.
 *
 * env.ts exits the process when required vars are missing — stub
 * them before importing wallet-fees (which imports env).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
process.env.HMAC_SECRET ??= 'test-hmac-secret-1234';
// Assert the DEFAULT: ignore any local .env override.
delete process.env.WALLET_FEE_RATE;

// require() (not a static import) so the env stubs above run before
// env.ts is evaluated.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WALLET_FEE_RATE, walletFee } = require('../wallet-fees') as typeof import('../wallet-fees');

// Withdraw model: fee ADDED → debited = amount + fee, received = amount.
// Deposit model: fee DEDUCTED → credited = amount − fee.
const withdrawTotal = (amount: number) => Math.round((amount + walletFee(amount)) * 100) / 100;
const depositNet    = (amount: number) => Math.round((amount - walletFee(amount)) * 100) / 100;

describe('wallet fee rate (api)', () => {
  it('defaults to 5% when WALLET_FEE_RATE is unset', () => {
    assert.equal(WALLET_FEE_RATE, 0.05);
  });

  const CASES: [number, number, number, number][] = [
    // amount, fee, withdraw total debited, deposit net credited
    [100, 5,    105,   95],
    [250, 12.5, 262.5, 237.5],
    [500, 25,   525,   475],
    [1,   0.05, 1.05,  0.95],
    [10,  0.5,  10.5,  9.5],
  ];

  for (const [amount, expectedFee, expectedTotal, expectedNet] of CASES) {
    it(`amount ${amount} → fee ${expectedFee}, debited ${expectedTotal}, deposit net ${expectedNet}`, () => {
      assert.equal(walletFee(amount), expectedFee);
      assert.equal(withdrawTotal(amount), expectedTotal);
      assert.equal(depositNet(amount), expectedNet);
    });
  }

  it('fee never rounds to zero within allowed minimums', () => {
    assert.ok(walletFee(100) > 0); // CDF min withdraw
    assert.ok(walletFee(1) > 0);   // USD min
  });
});
