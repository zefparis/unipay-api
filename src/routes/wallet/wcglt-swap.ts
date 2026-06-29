import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { mintWCGLT } from '../../services/bridge';

const CGLT_PER_WCGLT = parseInt(process.env.CGLT_PER_WCGLT ?? '500', 10);

interface SwapBody {
  amount_cglt: number;
  bsc_address: string;
}

const wcgltSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SwapBody }>(
    '/wallet/wcglt-to-usdt',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount_cglt', 'bsc_address'],
          properties: {
            amount_cglt: { type: 'number', minimum: 1 },
            bsc_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
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

      const amountCglt = Math.trunc(Number(request.body.amount_cglt));
      if (!Number.isFinite(amountCglt) || amountCglt < CGLT_PER_WCGLT) {
        return reply.status(400).send({ error: 'invalid_amount', min: CGLT_PER_WCGLT });
      }
      if (amountCglt % CGLT_PER_WCGLT !== 0) {
        return reply.status(400).send({ error: 'amount_not_multiple', multiple: CGLT_PER_WCGLT });
      }

      const bscAddress = request.body.bsc_address.trim();

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, cglt_balance')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      const cgltBalance  = Number(wallet.cglt_balance ?? 0);
      if (amountCglt > cgltBalance) {
        return reply.status(402).send({ error: 'insufficient_cglt', available: cgltBalance });
      }

      const wcgltReceived = amountCglt / CGLT_PER_WCGLT;
      const orderId       = crypto.randomUUID();
      const reference     = `WCS-${orderId.slice(0, 8).toUpperCase()}`;

      // Debit CGLT before bridge call
      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: cgltBalance - amountCglt })
        .eq('id', payload.wallet_id);

      // Bridge: mint wCGLT on BSC to user's address
      let txHash: string;
      try {
        txHash = await mintWCGLT(bscAddress, amountCglt);
      } catch (e) {
        // Refund on bridge failure
        await fastify.supabase
          .from('wallet_users')
          .update({ cglt_balance: cgltBalance })
          .eq('id', payload.wallet_id);
        fastify.log.error({ err: e }, '[wcglt-swap] bridge failed — CGLT refunded');
        return reply.status(502).send({ error: 'bridge_failed' });
      }

      await fastify.supabase.from('transactions').insert({
        id:                 orderId,
        wallet_user_id:     wallet.id,
        operator:           'wcglt_swap',
        direction:          'swap',
        amount:             amountCglt,
        fee:                0,
        net_amount:         wcgltReceived,
        currency:           'CGLT',
        reference,
        cglt_amount:        amountCglt,
        blockchain_tx_hash: txHash,
        status:             'success',
        metadata:           { wcglt_received: wcgltReceived, bsc_address: bscAddress },
      });

      fastify.log.info(
        { walletId: payload.wallet_id, amountCglt, wcgltReceived, txHash },
        '[wcglt-swap] completed',
      );

      return reply.status(201).send({
        success:        true,
        cglt_spent:     amountCglt,
        wcglt_received: wcgltReceived,
        tx_hash:        txHash,
        bsc_address:    bscAddress,
      });
    },
  );
};

export default wcgltSwapRoute;
