"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adminTransactionsRoute = async (fastify) => {
    fastify.get('/admin/transactions', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    status: { type: 'string', enum: ['pending', 'processing', 'success', 'failed', 'cancelled'] },
                    operator: { type: 'string', enum: ['vodacash', 'orange', 'airtel', 'afrimoney', 'usdt'] },
                    merchant_id: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        const { page, limit, status, operator, merchant_id } = request.query;
        const offset = (page - 1) * limit;
        let query = fastify.supabase
            .from('transactions')
            .select('id, merchant_id, operator, direction, amount, fee, net_amount, currency, phone, reference, avada_transaction_id, status, created_at, updated_at, operators(name, email)', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (status)
            query = query.eq('status', status);
        if (operator)
            query = query.eq('operator', operator);
        if (merchant_id)
            query = query.eq('merchant_id', merchant_id);
        const { data, error, count } = await query;
        if (error) {
            fastify.log.error({ err: error }, 'Admin transactions query failed');
            return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        return {
            data: data ?? [],
            pagination: {
                page,
                limit,
                total: count ?? 0,
                pages: Math.ceil((count ?? 0) / limit),
            },
        };
    });
};
exports.default = adminTransactionsRoute;
//# sourceMappingURL=transactions.js.map