import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { verifyToken } from '../../utils/jwt';

const merchantBalanceRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/merchant/balance',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              merchant_id: { type: 'string' },
              balance_cdf: { type: 'number' },
              currency: { type: 'string' },
            },
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

      const { data, error } = await fastify.supabase
        .from('operators')
        .select('id, balance_cdf')
        .eq('id', payload.merchant_id)
        .maybeSingle();

      if (error || !data) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      return {
        merchant_id: data.id,
        balance_cdf: data.balance_cdf ?? 0,
        currency: 'CDF',
      };
    },
  );
};

export default merchantBalanceRoute;
