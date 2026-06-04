import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { verifyToken } from '../../utils/jwt';

interface TransactionQuery {
  page: number;
  limit: number;
  status?: string;
  operator?: string;
  direction?: string;
}

const merchantTransactionsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: TransactionQuery }>(
    '/merchant/transactions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['pending', 'processing', 'success', 'failed', 'cancelled'] },
            operator: { type: 'string', enum: ['vodacash', 'orange', 'airtel', 'afrimoney', 'usdt'] },
            direction: { type: 'string', enum: ['collect', 'payout'] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const auth = request.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing bearer token', statusCode: 401 });
      }
      const payload = verifyToken(auth.slice(7), env.JWT_SECRET);
      if (!payload) {
        return reply.status(401).send({ error: 'Invalid or expired token', statusCode: 401 });
      }

      const { page, limit, status, operator, direction } = request.query;
      const offset = (page - 1) * limit;

      let query = fastify.supabase
        .from('transactions')
        .select('id, operator, direction, amount, fee, net_amount, currency, phone, reference, avada_transaction_id, status, created_at, updated_at', { count: 'exact' })
        .eq('merchant_id', payload.merchant_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (status) query = query.eq('status', status);
      if (operator) query = query.eq('operator', operator);
      if (direction) query = query.eq('direction', direction);

      const { data, error, count } = await query;

      if (error) {
        fastify.log.error({ err: error, merchantId: payload.merchant_id }, 'Merchant transactions query failed');
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

export default merchantTransactionsRoute;
