import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

const walletBalanceRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/wallet/balance',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              wallet_id:    { type: 'string' },
              balance_cdf:  { type: 'number' },
              cglt_balance: { type: 'number' },
              currency:     { type: 'string' },
              kyc_level:    { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { data, error } = await fastify.supabase
        .from('wallet_users')
        .select('id, balance_cdf, cglt_balance, kyc_level, is_active')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (error || !data) {
        return reply.status(404).send({ error: 'Wallet not found', statusCode: 404 });
      }

      if (!data.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      return {
        wallet_id:    data.id,
        balance_cdf:  Number(data.balance_cdf ?? 0),
        cglt_balance: Number(data.cglt_balance ?? 0),
        currency:     'CDF',
        kyc_level:    data.kyc_level ?? 0,
      };
    },
  );
};

export default walletBalanceRoute;
