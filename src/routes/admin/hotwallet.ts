/**
 * Admin routes — BSC hot wallet monitoring.
 *
 * GET /v1/admin/hotwallet/balance
 *
 * Auth: x-admin-secret header (hmac plugin).
 */

import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { getHotWalletBalances } from '../../lib/bsc-withdrawal';

const adminHotwalletRoute: FastifyPluginAsync = async (fastify) => {

  fastify.get(
    '/admin/hotwallet/balance',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const secret = request.headers['x-admin-secret'];
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (!env.HOT_WALLET_USDT_PRIVATE_KEY) {
        return reply.status(503).send({ error: 'Hot wallet not configured' });
      }

      try {
        const balances = await getHotWalletBalances();
        return reply.send({
          address:      balances.address,
          usdt_balance: balances.usdt,
          bnb_balance:  balances.bnb,
          network:      'BSC',
          contract:     env.USDT_BSC_CONTRACT,
        });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to fetch hot wallet balances');
        return reply.status(502).send({ error: 'Failed to query blockchain' });
      }
    },
  );

};

export default adminHotwalletRoute;
