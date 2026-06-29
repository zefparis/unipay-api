/**
 * Admin routes — ADI Chain monitoring
 *
 * GET /v1/admin/adi/deposits    — last 50 adi_deposit_events
 * GET /v1/admin/adi/withdrawals — last 50 adi_withdrawal_requests
 *
 * Auth: request.isAdmin (x-admin-secret middleware)
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminAdiRoute: FastifyPluginAsync;
export default adminAdiRoute;
