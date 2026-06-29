"use strict";
/**
 * Admin routes — ADI Chain monitoring
 *
 * GET /v1/admin/adi/deposits    — last 50 adi_deposit_events
 * GET /v1/admin/adi/withdrawals — last 50 adi_withdrawal_requests
 *
 * Auth: request.isAdmin (x-admin-secret middleware)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const adminAdiRoute = async (fastify) => {
    /* ── GET /v1/admin/adi/deposits ─────────────────────────────────────── */
    fastify.get('/admin/adi/deposits', async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const { data, error } = await fastify.supabase
            .from('adi_deposit_events')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) {
            fastify.log.error({ err: error }, '[admin/adi] deposit_events query failed');
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
        return { data: data ?? [] };
    });
    /* ── GET /v1/admin/adi/withdrawals ──────────────────────────────────── */
    fastify.get('/admin/adi/withdrawals', async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const { data, error } = await fastify.supabase
            .from('adi_withdrawal_requests')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) {
            fastify.log.error({ err: error }, '[admin/adi] withdrawal_requests query failed');
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
        return { data: data ?? [] };
    });
};
exports.default = adminAdiRoute;
//# sourceMappingURL=adi.js.map