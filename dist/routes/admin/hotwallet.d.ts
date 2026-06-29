/**
 * Admin routes — BSC hot wallet monitoring.
 *
 * GET /v1/admin/hotwallet/balance
 *
 * Auth: x-admin-secret header (hmac plugin).
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminHotwalletRoute: FastifyPluginAsync;
export default adminHotwalletRoute;
