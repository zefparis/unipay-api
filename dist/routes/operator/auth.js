"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const authRoute = async (fastify) => {
    fastify.post('/auth/token', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        operator_id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        balance_usd: { type: 'number' },
                        status: { type: 'string' },
                        is_admin: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        const { data: operator, error } = await fastify.supabase
            .from('operators')
            .select('id, name, email, balance_usd, status, is_admin')
            .eq('id', request.operatorId)
            .single();
        if (error || !operator) {
            fastify.log.error({ err: error, operatorId: request.operatorId }, 'Operator lookup failed');
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        }
        return {
            operator_id: operator.id,
            name: operator.name,
            email: operator.email,
            balance_usd: operator.balance_usd,
            status: operator.status,
            is_admin: operator.is_admin,
        };
    });
};
exports.default = authRoute;
//# sourceMappingURL=auth.js.map