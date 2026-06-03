import type { FastifyPluginAsync } from 'fastify';

interface StatusParams {
  id: string;
}

const statusRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: StatusParams }>(
    '/payment/:id/status',
    {
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
              channel: { type: 'string' },
              direction: { type: 'string' },
              amount_usd: { type: 'number' },
              amount_local: { type: 'number' },
              currency: { type: 'string' },
              phone: { type: 'string' },
              provider_ref: { type: ['string', 'null'] },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const { data, error } = await fastify.supabase
        .from('transactions')
        .select('*')
        .eq('id', id)
        .eq('operator_id', request.operatorId)
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
        channel: data.channel,
        direction: data.direction,
        amount_usd: data.amount_usd,
        amount_local: data.amount_local,
        currency: data.currency,
        phone: data.phone,
        provider_ref: data.provider_ref ?? null,
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
    },
  );
};

export default statusRoute;
