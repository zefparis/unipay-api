"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const jwt_1 = require("../../utils/jwt");
const avada_1 = require("../../services/avada");
const merchantBalanceRoute = async (fastify) => {
    fastify.get('/merchant/balance', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        balance: { type: 'number' },
                        currency: { type: 'string' },
                        mode: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const auth = request.headers.authorization;
        if (!auth?.startsWith('Bearer ')) {
            return reply.status(401).send({ error: 'Missing bearer token', statusCode: 401 });
        }
        const payload = (0, jwt_1.verifyToken)(auth.slice(7), env_1.env.JWT_SECRET);
        if (!payload) {
            return reply.status(401).send({ error: 'Invalid or expired token', statusCode: 401 });
        }
        const { data, error } = await fastify.supabase
            .from('merchants')
            .select('id, name, email, mode')
            .eq('id', payload.merchant_id)
            .maybeSingle();
        if (error || !data) {
            return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
        }
        let balance = 0;
        try {
            const avadaBalance = await (0, avada_1.getBalance)();
            balance = avadaBalance.balance;
        }
        catch (e) {
            fastify.log.warn({ err: e, merchantId: payload.merchant_id }, '[balance] getBalance() failed, returning 0');
        }
        fastify.log.info({ merchantId: payload.merchant_id, balance, mode: data.mode }, '[balance] returned');
        return reply.send({
            balance,
            currency: 'CDF',
            mode: data.mode,
        });
    });
};
exports.default = merchantBalanceRoute;
//# sourceMappingURL=balance.js.map