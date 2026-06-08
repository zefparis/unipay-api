import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { getSwapRate, executeSwap, mintCGLT, burnCGLT } from '../../services/blockchain';
import type { SwapDirection } from '../../services/blockchain';

// AMM swaps (CGLT <-> USDT) plus internal 1:1 conversions (CDF <-> CGLT).
type SwapRouteDirection = SwapDirection | 'cdf_to_cglt' | 'cglt_to_cdf';

interface SwapBody {
  direction: SwapRouteDirection;
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
            direction: { type: 'string', enum: ['cglt_to_usdt', 'usdt_to_cglt', 'cdf_to_cglt', 'cglt_to_cdf'] },
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
        .select('id, phone, is_active, balance_cdf, cglt_balance, usdt_balance, blockchain_address')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'Wallet not found', statusCode: 404 });
      }
      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const cdfBalance  = Number(wallet.balance_cdf ?? 0);
      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      const usdtBalance = Number(wallet.usdt_balance ?? 0);

      /* ── Internal 1:1 conversions (CDF <-> CGLT, free) ──────── */
      if (direction === 'cdf_to_cglt' || direction === 'cglt_to_cdf') {
        if (direction === 'cdf_to_cglt' && cdfBalance < amount) {
          return reply.status(402).send({
            error: 'Insufficient CDF balance', balance_cdf: cdfBalance, required: amount, statusCode: 402,
          });
        }
        if (direction === 'cglt_to_cdf' && cgltBalance < amount) {
          return reply.status(402).send({
            error: 'Insufficient CGLT balance', cglt_balance: cgltBalance, required: amount, statusCode: 402,
          });
        }

        // On-chain mint/burn (treasury-mediated). Requires a blockchain address.
        let blockchainTxHash: string | null = null;
        const txId      = crypto.randomUUID();
        const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;

        if (wallet.blockchain_address) {
          try {
            blockchainTxHash = direction === 'cdf_to_cglt'
              ? await mintCGLT(wallet.blockchain_address as string, amount, reference)
              : await burnCGLT(wallet.blockchain_address as string, amount, reference);
          } catch (err) {
            fastify.log.error({ err, walletId: wallet.id, direction, amount }, '[swap] on-chain mint/burn failed');
            return reply.status(502).send({ error: 'Conversion execution failed', statusCode: 502 });
          }
        }

        // Update ledger balances (1 CDF = 1 CGLT).
        const newCdfBalance  = direction === 'cdf_to_cglt' ? cdfBalance - amount : cdfBalance + amount;
        const newCgltBalance = direction === 'cdf_to_cglt' ? cgltBalance + amount : cgltBalance - amount;

        await fastify.supabase
          .from('wallet_users')
          .update({ balance_cdf: Math.max(newCdfBalance, 0), cglt_balance: Math.max(newCgltBalance, 0) })
          .eq('id', wallet.id);

        await fastify.supabase.from('transactions').insert({
          id:                 txId,
          wallet_user_id:     wallet.id,
          operator:           'cglt',
          direction:          'swap',
          amount,
          fee:                0,
          net_amount:         amount,
          currency:           direction === 'cdf_to_cglt' ? 'CDF' : 'CGLT',
          phone:              wallet.phone,
          reference,
          swap_direction:     direction,
          cglt_amount:        amount,
          blockchain_tx_hash: blockchainTxHash,
          status:             'success',
          metadata:           { source: 'wallet_swap', direction },
        });

        fastify.log.info({ walletId: wallet.id, direction, amount, txHash: blockchainTxHash }, '[swap] internal conversion completed');

        if (direction === 'cdf_to_cglt') {
          return reply.status(201).send({
            success: true, cdf_spent: amount, cglt_received: amount, blockchain_tx_hash: blockchainTxHash,
          });
        }
        return reply.status(201).send({
          success: true, cglt_spent: amount, cdf_received: amount, blockchain_tx_hash: blockchainTxHash,
        });
      }

      // CGLT -> USDT requires sufficient CGLT ledger balance
      if (direction === 'cglt_to_usdt' && cgltBalance < amount) {
        return reply.status(402).send({
          error:        'Insufficient CGLT balance',
          cglt_balance: cgltBalance,
          required:     amount,
          statusCode:   402,
        });
      }

      // USDT -> CGLT requires sufficient USDT ledger balance
      if (direction === 'usdt_to_cglt' && usdtBalance < amount) {
        return reply.status(402).send({
          error:        'Insufficient USDT balance',
          usdt_balance: usdtBalance,
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

      // ── Update CGLT + USDT ledger balances ─────────────────
      let newCgltBalance: number;
      let newUsdtBalance: number;
      if (direction === 'cglt_to_usdt') {
        // débite CGLT, crédite USDT
        newCgltBalance = Math.max(cgltBalance - amount, 0);
        newUsdtBalance = usdtBalance + result.amountOut;
      } else {
        // débite USDT, crédite CGLT
        newUsdtBalance = Math.max(usdtBalance - amount, 0);
        newCgltBalance = cgltBalance + result.amountOut;
      }

      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newCgltBalance, usdt_balance: newUsdtBalance })
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
