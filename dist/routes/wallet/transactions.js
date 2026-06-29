"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const walletTransactionsRoute = async (fastify) => {
    fastify.get('/wallet/transactions', {
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    page: { type: 'integer', minimum: 1, default: 1 },
                    limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
                    direction: { type: 'string', enum: ['collect', 'payout', 'p2p'] },
                    status: { type: 'string', enum: ['pending', 'processing', 'success', 'failed', 'cancelled'] },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const walletPayload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!walletPayload) {
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        }
        const { page, limit, direction, status } = request.query;
        const offset = (page - 1) * limit;
        let query = fastify.supabase
            .from('transactions')
            .select('id, operator, direction, amount, fee, net_amount, currency, usdt_amount, phone, reference, status, created_at, updated_at', { count: 'exact' })
            .eq('wallet_user_id', walletPayload.wallet_id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (direction)
            query = query.eq('direction', direction);
        if (status)
            query = query.eq('status', status);
        const { data, error, count } = await query;
        if (error) {
            fastify.log.error({ err: error, walletId: walletPayload.wallet_id }, 'Wallet transactions query failed');
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
exports.default = walletTransactionsRoute;
//# sourceMappingURL=transactions.js.map