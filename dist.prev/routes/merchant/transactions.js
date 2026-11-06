"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const merchant_auth_1 = require("../../lib/merchant-auth");
const merchantTransactionsRoute = async (fastify) => {
    fastify.get('/merchant/transactions', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    status: { type: 'string', enum: ['pending', 'processing', 'success', 'failed', 'cancelled'] },
                    operator: { type: 'string', enum: ['orange', 'airtel', 'afrimoney', 'usdt'] },
                    direction: { type: 'string', enum: ['collect', 'payout'] },
                    currency: { type: 'string', enum: ['CDF', 'USD', 'USDT'] },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const auth = await (0, merchant_auth_1.requireActiveMerchant)(request, fastify.supabase);
        if (!auth.ok) {
            return reply.status(auth.status).send(auth.error);
        }
        const { page, limit, status, operator, direction, currency } = request.query;
        const offset = (page - 1) * limit;
        let query = fastify.supabase
            .from('transactions')
            .select('id, operator, direction, amount, fee, net_amount, currency, phone, reference, avada_transaction_id, status, created_at, updated_at, metadata', { count: 'exact' })
            .eq('merchant_id', auth.payload.merchant_id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (status)
            query = query.eq('status', status);
        if (operator)
            query = query.eq('operator', operator);
        if (direction)
            query = query.eq('direction', direction);
        if (currency)
            query = query.eq('currency', currency);
        const { data, error, count } = await query;
        if (error) {
            fastify.log.error({ err: error, merchantId: auth.payload.merchant_id }, 'Merchant transactions query failed');
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
exports.default = merchantTransactionsRoute;
//# sourceMappingURL=transactions.js.map