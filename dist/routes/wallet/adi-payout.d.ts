/**
 * ADI Chain payout routes.
 *
 * A) POST /v1/adi/payout-request  — wallet JWT, called by unipay-congo
 *    User requests a CDF withdrawal that will be settled via USDC on ADI Chain.
 *    Flow:
 *      1. Debit user balance_cdf atomically (wallet_debit RPC)
 *      2. Insert adi_withdrawal_requests {status: 'pending'}
 *      3. POST to PredictStreet payout webhook (HMAC-signed)
 *      4. Return { ok, withdrawal_id }
 *
 * B) POST /v1/adi/payout-status   — HMAC-signed, called BY PredictStreet
 *    PredictStreet updates us after sending (or failing) the USDC on-chain.
 *    Flow:
 *      1. Verify HMAC signature
 *      2. Update adi_withdrawal_requests.tx_hash + status
 *      3a. status='sent'   → waitForConfirmations(12) then Avada B2C CDF payout
 *      3b. status='failed' → refund user balance_cdf
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adiPayoutRoute: FastifyPluginAsync;
export default adiPayoutRoute;
