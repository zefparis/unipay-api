/**
 * USDT crypto withdrawal via Binance.
 *
 * POST /v1/wallet/crypto-withdraw
 * GET  /v1/wallet/crypto-withdrawals
 */
import type { FastifyPluginAsync } from 'fastify';
declare const walletCryptoWithdrawRoute: FastifyPluginAsync;
export default walletCryptoWithdrawRoute;
