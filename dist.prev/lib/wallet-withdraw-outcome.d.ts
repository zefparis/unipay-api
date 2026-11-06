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
export declare const DEFINITIVE_REJECT_CODES: ReadonlySet<number>;
export type PayoutFailure = {
    kind: 'definitive';
    code?: number;
    reason: string;
} | {
    kind: 'ambiguous';
    code?: number;
    reason: string;
};
export declare function classifyPayoutFailure(err: unknown): PayoutFailure;
export interface ClaimErrorMapping {
    status: number;
    error: string;
}
export declare function mapClaimError(message: string): ClaimErrorMapping | null;
/** HTTP status for an idempotent replay, by the ORIGINAL tx status. */
export declare function replayStatusCode(txStatus: string): 201 | 409;
