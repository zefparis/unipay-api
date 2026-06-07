import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { getSwapRate, executeSwap } from '../../services/blockchain';
import type { SwapDirection } from '../../services/blockchain';

interface SwapBody {
  direction: SwapDirection;
  amount: number;
}

const walletSwapRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/wallet/swap/rate ───────────────────────────── */
  fastify.get('/wallet/swap/rate', async (_request, reply) => {
    try {
      const rate = await getSwapRate();
      return rate;
    } catch (err) {
      fastify.log.error({ err }, '[swap] rate fetch failed');
      return reply.status(503).send({ error: 'Swap service unavailable', statusCode: 503 });
    }
  });

  /* ── POST /v1/wallet/swap ───────────────────────────────── */
  fastify.post<{ Body: SwapBody }>(
    '/wallet/swap',
    {
      schema: {
        body: {
          type: 'object',
          required: ['direction', 'amount'],
          properties: {
            direction: { type: 'string', enum: ['cglt_to_usdt', 'usdt_to_cglt'] },
            amount:    { type: 'number', minimum: 0 },
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

      const { direction, amount } = request.body;
      if (!amount || amount <= 0) {
        return reply.status(400).send({ error: 'Invalid amount', statusCode: 400 });
      }

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, is_active, cglt_balance, blockchain_address')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'Wallet not found', statusCode: 404 });
      }
      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const cgltBalance = Number(wallet.cglt_balance ?? 0);

      // CGLT -> USDT requires sufficient CGLT ledger balance
      if (direction === 'cglt_to_usdt' && cgltBalance < amount) {
        return reply.status(402).send({
          error:        'Insufficient CGLT balance',
          cglt_balance: cgltBalance,
          required:     amount,
          statusCode:   402,
        });
      }

      // ── Execute the on-chain swap (treasury-mediated) ──────
      let result;
      try {
        result = await executeSwap(direction, amount);
      } catch (err) {
        fastify.log.error({ err, walletId: wallet.id, direction, amount }, '[swap] on-chain swap failed');
        return reply.status(502).send({ error: 'Swap execution failed', statusCode: 502 });
      }

      // ── Update CGLT ledger balance ─────────────────────────
      const newCgltBalance =
        direction === 'cglt_to_usdt'
          ? Math.max(cgltBalance - amount, 0)
          : cgltBalance + result.amountOut;

      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newCgltBalance })
        .eq('id', wallet.id);

      // ── Record transaction ─────────────────────────────────
      const txId      = crypto.randomUUID();
      const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;
      const cgltAmount = direction === 'cglt_to_usdt' ? amount : result.amountOut;
      const usdtAmount = direction === 'cglt_to_usdt' ? result.amountOut : amount;

      await fastify.supabase.from('transactions').insert({
        id:                 txId,
        wallet_user_id:     wallet.id,
        operator:           'cglt',
        direction:          'swap',
        amount,
        fee:                result.fee,
        net_amount:         result.amountOut,
        currency:           'CGLT',
        phone:              wallet.phone,
        reference,
        swap_direction:     direction,
        cglt_amount:        cgltAmount,
        usdt_amount:        usdtAmount,
        blockchain_tx_hash: result.txHash,
        status:             'success',
        metadata:           { source: 'wallet_swap', direction },
      });

      fastify.log.info(
        { walletId: wallet.id, direction, amountIn: result.amountIn, amountOut: result.amountOut, txHash: result.txHash },
        '[swap] completed',
      );

      return reply.status(201).send({
        success:    true,
        amount_in:  result.amountIn,
        amount_out: result.amountOut,
        fee:        result.fee,
        tx_hash:    result.txHash,
      });
    },
  );
};

export default walletSwapRoute;
