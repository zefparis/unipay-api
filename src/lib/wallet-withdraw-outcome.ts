/**
 * Money-safety decisions for the wallet CDF withdrawal route, kept pure
 * (no I/O) so they can be unit-tested exhaustively.
 *
 *  - classifyPayoutFailure: did the provider PROVABLY create nothing
 *    (→ safe to refund synchronously) or is the outcome ambiguous
 *    (→ never refund here; leave 'pending' for the reconciliation
 *    worker, which asks Unipesa /status by order_id)?
 *  - mapClaimError: wallet_withdraw_claim exception → HTTP status.
 *  - replayStatusCode: idempotent replay → 201 or 409.
 */

/**
 * result.code values Unipesa returns on /payment_b2c initiation that
 * are PROVEN (observed in production metadata) to mean the payout was
 * rejected before creation:
 *   10105 WRONG MERCHANT_ID   — merchant identity rejected
 *   10401 MSISDN INCORRECT    — operator refused the number
 * Anything else — including outage-looking codes such as 10201/10301
 * for which we have no proof that no order was created — is AMBIGUOUS.
 */
export const DEFINITIVE_REJECT_CODES: ReadonlySet<number> = new Set([10105, 10401]);

export type PayoutFailure =
  | { kind: 'definitive'; code?: number; reason: string }
  | { kind: 'ambiguous'; code?: number; reason: string };

export function classifyPayoutFailure(err: unknown): PayoutFailure {
  const raw = err instanceof Error ? err.message : String(err);

  // Thrown by services/avada.ts BEFORE any network call — no request
  // ever left the process, so nothing can exist at the provider.
  if (/^FIXIE_PROXY_REQUIRED|^Unknown operator/.test(raw)) {
    return { kind: 'definitive', reason: 'pre_network_failure' };
  }

  // "Unipesa provider error: code=10105 message=WRONG MERCHANT_ID"
  // → HTTP 200 + readable JSON + explicit non-zero result.code.
  const m = raw.match(/Unipesa provider error: code=(-?\d+)/);
  if (m) {
    const code = Number(m[1]);
    return DEFINITIVE_REJECT_CODES.has(code)
      ? { kind: 'definitive', code, reason: `provider_rejected_${code}` }
      : { kind: 'ambiguous', code, reason: `provider_code_unknown_${code}` };
  }

  // Timeout, network error, HTTP 4xx/5xx, non-JSON body, "did not
  // create a transaction", anything unrecognised.
  return { kind: 'ambiguous', reason: 'provider_outcome_unknown' };
}

export interface ClaimErrorMapping {
  status: number;
  error: string;
}

const CLAIM_400_CODES = /INVALID_TOTAL|INVALID_AMOUNT|INVALID_FEE|UNSUPPORTED_WALLET_CURRENCY/;

export function mapClaimError(message: string): ClaimErrorMapping | null {
  if (message.includes('IDEMPOTENCY_KEY_REUSED')) return { status: 422, error: 'IDEMPOTENCY_KEY_REUSED' };
  if (message.includes('KYC_LIMIT_EXCEEDED'))     return { status: 403, error: 'KYC_LIMIT_EXCEEDED' };
  if (message.includes('INSUFFICIENT_FUNDS'))     return { status: 402, error: 'Insufficient balance' };
  if (message.includes('WALLET_SUSPENDED'))       return { status: 403, error: 'Account is suspended' };
  if (message.includes('WALLET_NOT_FOUND'))       return { status: 404, error: 'Wallet not found' };
  const bad = message.match(CLAIM_400_CODES);
  if (bad) return { status: 400, error: bad[0] };
  return null;
}

/** HTTP status for an idempotent replay, by the ORIGINAL tx status. */
export function replayStatusCode(txStatus: string): 201 | 409 {
  return txStatus === 'failed' || txStatus === 'cancelled' ? 409 : 201;
}
