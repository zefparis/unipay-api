"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function requireAdmin(isAdmin) {
    return isAdmin;
}
const actionLogRoute = async (fastify) => {
    /* ── GET /v1/admin/action-log ───────────────────────────────── */
    fastify.get('/admin/action-log', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                    action: { type: 'string', maxLength: 128 },
                    resource_type: { type: 'string', maxLength: 64 },
                    resource_id: { type: 'string', format: 'uuid' },
                    from: { type: 'string', format: 'date' },
                    to: { type: 'string', format: 'date' },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireAdmin(request.isAdmin)) {
            return reply.status(403).send({ error: 'Admin access required' });
        }
        const { page, limit, action, resource_type, resource_id, from, to } = request.query;
        const offset = (page - 1) * limit;
        let query = fastify.supabase
            .from('admin_action_log')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (action)
            query = query.eq('action', action);
        if (resource_type)
            query = query.eq('resource_type', resource_type);
        if (resource_id)
            query = query.eq('resource_id', resource_id);
        if (from)
            query = query.gte('created_at', from);
        if (to)
            query = query.lte('created_at', to);
        const { data, error, count } = await query;
        if (error) {
            fastify.log.error({ err: error }, '[admin/action-log] query failed');
            return reply.status(500).send({ error: error.message });
        }
        return reply.send({
            data: data ?? [],
            pagination: {
                page,
                limit,
                total: count ?? 0,
                pages: Math.ceil((count ?? 0) / limit),
            },
        });
    });
};
exports.default = actionLogRoute;
//# sourceMappingURL=action-log.js.map