/**
 * Admin routes — Binance account management.
 *
 * GET  /v1/admin/binance/balances
 * POST /v1/admin/binance/withdraw
 * GET  /v1/admin/binance/withdrawals
 *
 * Auth: x-admin-secret OR api-key with is_admin + ADMIN_EMAILS (hmac plugin).
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminBinanceRoute: FastifyPluginAsync;
export default adminBinanceRoute;
