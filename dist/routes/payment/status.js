"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const statusRoute = async (fastify) => {
    fastify.get('/payment/:id/status', {
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', format: 'uuid' },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        transaction_id: { type: 'string' },
                        status: { type: 'string' },
                        operator: { type: 'string' },
                        direction: { type: 'string' },
                        amount: { type: 'number' },
                        fee: { type: 'number' },
                        net_amount: { type: 'number' },
                        currency: { type: 'string' },
                        phone: { type: 'string' },
                        reference: { type: ['string', 'null'] },
                        avada_transaction_id: { type: ['string', 'null'] },
                        created_at: { type: 'string' },
                        updated_at: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;
        const { data, error } = await fastify.supabase
            .from('transactions')
            .select('id, merchant_id, operator, direction, amount, fee, net_amount, currency, phone, reference, avada_transaction_id, status, created_at, updated_at')
            .eq('id', id)
            .eq('merchant_id', request.operatorId)
            .maybeSingle();
        if (error) {
            fastify.log.error({ err: error, id }, 'Status lookup error');
            return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        if (!data) {
            return reply.status(404).send({ error: 'Transaction not found', statusCode: 404 });
        }
        return {
            transaction_id: data.id,
            status: data.status,
            operator: data.operator,
            direction: data.direction,
            amount: data.amount,
            fee: data.fee,
            net_amount: data.net_amount,
            currency: data.currency,
            phone: data.phone,
            reference: data.reference ?? null,
            avada_transaction_id: data.avada_transaction_id ?? null,
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
    });
};
exports.default = statusRoute;
//# sourceMappingURL=status.js.map