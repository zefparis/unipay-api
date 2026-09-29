/**
 * Money-safety decisions of the wallet withdrawal route (pure functions).
 *
 * The single most important property: ONLY provably-rejected provider
 * outcomes are 'definitive' (→ synchronous refund). Everything else is
 * 'ambiguous' (→ no refund, reconciliation decides).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFINITIVE_REJECT_CODES,
  classifyPayoutFailure,
  mapClaimError,
  replayStatusCode,
} from '../wallet-withdraw-outcome';

describe('DEFINITIVE_REJECT_CODES', () => {
  it('contains exactly the two proven rejection codes', () => {
    assert.deepEqual([...DEFINITIVE_REJECT_CODES].sort(), [10105, 10401]);
  });
  it('does NOT contain outage-looking codes without proof (10201, 10301)', () => {
    assert.equal(DEFINITIVE_REJECT_CODES.has(10201), false);
    assert.equal(DEFINITIVE_REJECT_CODES.has(10301), false);
  });
});

describe('classifyPayoutFailure — definitive', () => {
  it('10105 WRONG MERCHANT_ID → definitive', () => {
    const r = classifyPayoutFailure(new Error('Unipesa provider error: code=10105 message=WRONG MERCHANT_ID'));
    assert.deepEqual(r, { kind: 'definitive', code: 10105, reason: 'provider_rejected_10105' });
  });
  it('10401 MSISDN INCORRECT → definitive', () => {
    const r = classifyPayoutFailure(new Error('Unipesa provider error: code=10401 message=MSISDN INCORRECT'));
    assert.equal(r.kind, 'definitive');
    assert.equal(r.code, 10401);
  });
  it('FIXIE_PROXY_REQUIRED (thrown before any network call) → definitive', () => {
    const r = classifyPayoutFailure(new Error('FIXIE_PROXY_REQUIRED: FIXIE_URL is not set'));
    assert.deepEqual(r, { kind: 'definitive', reason: 'pre_network_failure' });
  });
  it('Unknown operator (thrown before any network call) → definitive', () => {
    assert.equal(classifyPayoutFailure(new Error('Unknown operator: Foo')).kind, 'definitive');
  });
});

describe('classifyPayoutFailure — ambiguous', () => {
  const AMBIGUOUS: [string, string][] = [
    ['unknown result.code',        'Unipesa provider error: code=99999 message=whatever'],
    ['10301 get token error',      'Unipesa provider error: code=10301 message=REQUEST SENDING ERROR | get token error'],
    ['10201',                      'Unipesa provider error: code=10201 message=x'],
    ['timeout (AbortSignal)',      'The operation was aborted due to timeout'],
    ['TimeoutError name only',     'TimeoutError'],
    ['fetch failed',               'fetch failed'],
    ['ECONNRESET',                 'read ECONNRESET'],
    ['ETIMEDOUT',                  'connect ETIMEDOUT 1.2.3.4:443'],
    ['HTTP 502',                   'Unipesa HTTP 502: <html>Bad Gateway</html>'],
    ['HTTP 403 (gateway)',         'Unipesa HTTP 403: Forbidden'],
    ['non-JSON body',              'Unipesa non-JSON response: <html>'],
    ['OK but no transaction_id',   'Unipesa provider did not create a transaction: An unexpected error occurred'],
    ['empty message',              ''],
  ];
  for (const [label, msg] of AMBIGUOUS) {
    it(`${label} → ambiguous`, () => {
      assert.equal(classifyPayoutFailure(new Error(msg)).kind, 'ambiguous');
    });
  }
  it('non-Error input → ambiguous', () => {
    assert.equal(classifyPayoutFailure('boom').kind, 'ambiguous');
    assert.equal(classifyPayoutFailure(undefined).kind, 'ambiguous');
  });
  it('unknown code is reported for logging', () => {
    const r = classifyPayoutFailure(new Error('Unipesa provider error: code=13104 message=x'));
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.code, 13104);
  });
});

describe('mapClaimError', () => {
  it('IDEMPOTENCY_KEY_REUSED → 422', () => {
    assert.deepEqual(mapClaimError('IDEMPOTENCY_KEY_REUSED'), { status: 422, error: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('INSUFFICIENT_FUNDS → 402 (unchanged)', () => {
    assert.equal(mapClaimError('INSUFFICIENT_FUNDS: balance 50, required 105')?.status, 402);
  });
  it('KYC_LIMIT_EXCEEDED → 403 (unchanged)', () => {
    assert.equal(mapClaimError('KYC_LIMIT_EXCEEDED: daily_used 0, requested 105, limit 100')?.status, 403);
  });
  it('WALLET_SUSPENDED → 403', () => {
    assert.equal(mapClaimError('WALLET_SUSPENDED')?.status, 403);
  });
  for (const code of ['INVALID_TOTAL', 'INVALID_AMOUNT: amount must be > 0', 'INVALID_FEE: fee must be >= 0', 'UNSUPPORTED_WALLET_CURRENCY']) {
    it(`${code.split(':')[0]} → 400`, () => {
      const m = mapClaimError(code);
      assert.equal(m?.status, 400);
      assert.equal(m?.error, code.split(':')[0]);
    });
  }
  it('unknown → null (route answers 500)', () => {
    assert.equal(mapClaimError('something else'), null);
  });
});

describe('replayStatusCode', () => {
  for (const s of ['pending', 'processing', 'success']) {
    it(`${s} → 201`, () => assert.equal(replayStatusCode(s), 201));
  }
  for (const s of ['failed', 'cancelled']) {
    it(`${s} → 409`, () => assert.equal(replayStatusCode(s), 409));
  }
});
