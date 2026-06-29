"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const balanceRoute = async (fastify) => {
    fastify.get('/operator/balance', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        operator_id: { type: 'string' },
                        balance_usd: { type: 'number' },
                        currency: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { data, error } = await fastify.supabase
            .from('operators')
            .select('id, balance_usd')
            .eq('id', request.operatorId)
            .single();
        if (error || !data) {
            return reply.status(404).send({ error: 'Operator not found', statusCode: 404 });
        }
        return {
            operator_id: data.id,
            balance_usd: data.balance_usd,
            currency: 'USD',
        };
    });
};
exports.default = balanceRoute;
//# sourceMappingURL=balance.js.map