import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { getBalance } from '../../services/avada';
import { requireActiveMerchant } from '../../lib/merchant-auth';

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

      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) {
        return reply.status(auth.status).send(auth.error);
      }

      const { data, error } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, mode')
        .eq('id', auth.payload.merchant_id)
        .maybeSingle();

      if (error || !data) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      let balance = 0;
      try {
        const avadaBalance = await getBalance();
        balance = avadaBalance.balance;
      } catch (e) {
        fastify.log.warn({ err: e, merchantId: auth.payload.merchant_id }, '[balance] getBalance() failed, returning 0');
      }

      fastify.log.info({ merchantId: auth.payload.merchant_id, balance, mode: data.mode }, '[balance] returned');

      return reply.send({
        balance,
        currency: 'CDF',
        mode: data.mode,
      });
    },
  );
};

export default merchantBalanceRoute;
