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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderOutageFailure } from '../provider-outage.js';

describe('isProviderOutageFailure', () => {
  it('returns false for null metadata', () => {
    assert.equal(isProviderOutageFailure(null), false);
  });

  it('returns false for empty metadata', () => {
    assert.equal(isProviderOutageFailure({}), false);
  });

  it('returns false for client errors (insufficient balance)', () => {
    assert.equal(isProviderOutageFailure({ reason: 'Insufficient balance' }), false);
  });

  it('returns false for client errors (wrong MSISDN)', () => {
    assert.equal(isProviderOutageFailure({ reason: 'MSISDN INCORRECT' }), false);
  });

  it('detects unipesa_result_code 10301 (reconciliation)', () => {
    assert.equal(isProviderOutageFailure({ unipesa_result_code: 10301 }), true);
  });

  it('detects unipesa_result_code 10201 (reconciliation)', () => {
    assert.equal(isProviderOutageFailure({ unipesa_result_code: 10201 }), true);
  });

  it('does not flag non-outage result codes', () => {
    assert.equal(isProviderOutageFailure({ unipesa_result_code: 200 }), false);
    assert.equal(isProviderOutageFailure({ unipesa_result_code: 0 }), false);
  });

  it('detects result.code 10301 (callback)', () => {
    assert.equal(isProviderOutageFailure({ result: { code: 10301 } }), true);
  });

  it('detects result.code 10201 (callback)', () => {
    assert.equal(isProviderOutageFailure({ result: { code: 10201 } }), true);
  });

  it('does not flag result.code for non-outage codes', () => {
    assert.equal(isProviderOutageFailure({ result: { code: 200 } }), false);
  });

  it('detects "API unreachable" in reason', () => {
    assert.equal(isProviderOutageFailure({ reason: 'Airtel API unreachable' }), true);
  });

  it('detects "get token error" in reason', () => {
    assert.equal(isProviderOutageFailure({ reason: 'get token error from provider' }), true);
  });

  it('detects "provider unavailable" in reason (case-insensitive)', () => {
    assert.equal(isProviderOutageFailure({ reason: 'Provider temporarily unavailable' }), true);
  });

  it('does not flag unrelated reason strings', () => {
    assert.equal(isProviderOutageFailure({ reason: 'Transaction cancelled by user' }), false);
    assert.equal(isProviderOutageFailure({ reason: 'Invalid phone number' }), false);
  });

  it('handles string unipesa_result_code gracefully (not a number)', () => {
    assert.equal(isProviderOutageFailure({ unipesa_result_code: '10301' }), false);
  });

  it('handles result.code as string gracefully (not a number)', () => {
    assert.equal(isProviderOutageFailure({ result: { code: '10301' } }), false);
  });
});
