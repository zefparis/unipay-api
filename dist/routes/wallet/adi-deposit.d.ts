/**
 * POST /v1/adi/deposit-notify
 *
 * HMAC-signed webhook called by PredictStreet when a user's USDC deposit
 * on ADI Chain is confirmed on-chain.
 *
 * Flow:
 *  1. Verify HMAC-SHA256 signature (X-PredictStreet-Signature header)
 *  2. Idempotency check — return 200 early if payout_id already processed
 *  3. Fetch on-chain receipt via getAdiTransactionReceipt()
 *  4. Verify ERC-20 Transfer log via verifyAdiTransfer()
 *  5. Insert into adi_deposit_events + credit user CDF balance
 *  6. Return { ok: true, credited_cdf }
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adiDepositRoute: FastifyPluginAsync;
export default adiDepositRoute;
