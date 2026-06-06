import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { verifyToken } from '../../utils/jwt';
import { getBalance } from '../../services/avada';

const merchantBalanceRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/merchant/balance',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              balance:  { type: 'number' },
              currency: { type: 'string' },
              mode:     { type: 'string' },
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
        .from('merchants')
        .select('id, name, email, mode')
        .eq('id', payload.merchant_id)
        .maybeSingle();

      if (error || !data) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      let balance = 0;
      try {
        const avadaBalance = await getBalance();
        balance = avadaBalance.balance;
      } catch (e) {
        fastify.log.warn({ err: e, merchantId: payload.merchant_id }, '[balance] getBalance() failed, returning 0');
      }

      fastify.log.info({ merchantId: payload.merchant_id, balance, mode: data.mode }, '[balance] returned');

      return reply.send({
        balance,
        currency: 'CDF',
        mode: data.mode,
      });
    },
  );
};

export default merchantBalanceRoute;
