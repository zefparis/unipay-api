import type { FastifyPluginAsync } from 'fastify';

interface TransactionQuery {
  page: number;
  limit: number;
  status?: 'pending' | 'processing' | 'success' | 'failed';
  channel?: 'vodacash' | 'orange' | 'airtel' | 'afrimoney' | 'usdt';
  operator_id?: string;
}

const adminTransactionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: TransactionQuery }>(
    '/admin/transactions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['pending', 'processing', 'success', 'failed'] },
            channel: { type: 'string', enum: ['vodacash', 'orange', 'airtel', 'afrimoney', 'usdt'] },
            operator_id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { page, limit, status, channel, operator_id } = request.query;
      const offset = (page - 1) * limit;

      let query = fastify.supabase
        .from('transactions')
        .select('*, operators(name, email)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (status) query = query.eq('status', status);
      if (channel) query = query.eq('channel', channel);
      if (operator_id) query = query.eq('operator_id', operator_id);

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
    },
  );
};

export default adminTransactionsRoute;
