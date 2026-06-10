import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { mintCGLT } from '../../services/blockchain';

const getFiatRate    = () => Number(env.FIAT_USD_CDF_RATE ?? '2850') || 2850;
const CGLT_PER_USDT  = Number(process.env.CGLT_PER_USDT ?? '500') || 500;
const CGLT_SWAP_FEE  = 0.005; // 0.5 %

// AMM swaps (CGLT <-> USDT), internal conversions (CDF <-> CGLT), and fiat/stablecoin (USD <-> CDF/USDT).
type SwapRouteDirection =
  | 'cglt_to_usdt' | 'usdt_to_cglt'
  | 'cdf_to_cglt'  | 'cglt_to_cdf'
  | 'usd_to_cdf'   | 'cdf_to_usd'
  | 'usd_to_usdt'  | 'usdt_to_usd';

interface SwapBody {
  direction: SwapRouteDirection;
  amount: number;
}

const walletSwapRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/wallet/swap/rate ───────────────────────────── */
  fastify.get('/wallet/swap/rate', async (_request, reply) => {
    return reply.send({
      rate:      CGLT_PER_USDT,
      fee:       CGLT_SWAP_FEE,
      paused:    false,
      pool_usdt: 0,
      pool_cglt: 0,
    });
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
            direction: { type: 'string', enum: ['cglt_to_usdt', 'usdt_to_cglt', 'cdf_to_cglt', 'cglt_to_cdf', 'usd_to_cdf', 'cdf_to_usd', 'usd_to_usdt', 'usdt_to_usd'] },
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
        .select('id, phone, is_active, balance_cdf, cglt_balance, usdt_balance, usd_balance, blockchain_address')
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
      const usdBalance  = Number(wallet.usd_balance  ?? 0);

      /* ── USD ↔ CDF  (rate = FIAT_USD_CDF_RATE, e.g. 2850) ────── */
      if (direction === 'usd_to_cdf' || direction === 'cdf_to_usd') {
        const rate = getFiatRate();
        if (direction === 'usd_to_cdf' && usdBalance < amount) {
          return reply.status(402).send({ error: 'Insufficient USD balance', usd_balance: usdBalance, required: amount, statusCode: 402 });
        }
        if (direction === 'cdf_to_usd') {
          const cdfCost = Math.ceil(amount * rate * 100) / 100;
          if (cdfBalance < cdfCost) {
            return reply.status(402).send({ error: 'Insufficient CDF balance', balance_cdf: cdfBalance, required: cdfCost, statusCode: 402 });
          }
        }

        const txId      = crypto.randomUUID();
        const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;

        let newUsdBalance: number;
        let newCdfBalance: number;
        let cdfAmount:  number;
        let usdAmount:  number;

        if (direction === 'usd_to_cdf') {
          usdAmount    = amount;
          cdfAmount    = Math.floor(amount * rate * 100) / 100;
          newUsdBalance = Math.max(usdBalance - usdAmount, 0);
          newCdfBalance = cdfBalance + cdfAmount;
        } else {
          // cdf_to_usd: amount is the USD desired; debit CDF equivalent
          usdAmount    = amount;
          cdfAmount    = Math.ceil(amount * rate * 100) / 100;
          newUsdBalance = usdBalance + usdAmount;
          newCdfBalance = Math.max(cdfBalance - cdfAmount, 0);
        }

        await fastify.supabase.from('wallet_users')
          .update({ balance_cdf: newCdfBalance, usd_balance: newUsdBalance })
          .eq('id', wallet.id);

        await fastify.supabase.from('transactions').insert({
          id:             txId,
          wallet_user_id: wallet.id,
          operator:       'unipesa',
          direction:      'swap',
          amount,
          fee:            0,
          net_amount:     direction === 'usd_to_cdf' ? cdfAmount : usdAmount,
          currency:       direction === 'usd_to_cdf' ? 'USD' : 'CDF',
          phone:          wallet.phone,
          reference,
          swap_direction: direction,
          status:         'success',
          metadata:       { source: 'wallet_swap', direction, rate },
        });

        fastify.log.info({ walletId: wallet.id, direction, amount, rate }, '[swap] fiat conversion completed');

        return reply.status(201).send({
          success:       true,
          direction,
          rate,
          ...(direction === 'usd_to_cdf'
            ? { usd_spent: usdAmount, cdf_received: cdfAmount }
            : { cdf_spent: cdfAmount, usd_received: usdAmount }
          ),
        });
      }

      /* ── USD ↔ USDT  (1:1 peg) ──────────────────────────────── */
      if (direction === 'usd_to_usdt' || direction === 'usdt_to_usd') {
        if (direction === 'usd_to_usdt' && usdBalance < amount) {
          return reply.status(402).send({ error: 'Insufficient USD balance', usd_balance: usdBalance, required: amount, statusCode: 402 });
        }
        if (direction === 'usdt_to_usd' && usdtBalance < amount) {
          return reply.status(402).send({ error: 'Insufficient USDT balance', usdt_balance: usdtBalance, required: amount, statusCode: 402 });
        }

        const txId      = crypto.randomUUID();
        const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;

        const newUsdBalance  = direction === 'usd_to_usdt' ? Math.max(usdBalance - amount, 0)  : usdBalance + amount;
        const newUsdtBalance = direction === 'usd_to_usdt' ? usdtBalance + amount : Math.max(usdtBalance - amount, 0);

        await fastify.supabase.from('wallet_users')
          .update({ usd_balance: newUsdBalance, usdt_balance: newUsdtBalance })
          .eq('id', wallet.id);

        await fastify.supabase.from('transactions').insert({
          id:             txId,
          wallet_user_id: wallet.id,
          operator:       'unipesa',
          direction:      'swap',
          amount,
          fee:            0,
          net_amount:     amount,
          currency:       direction === 'usd_to_usdt' ? 'USD' : 'USDT',
          phone:          wallet.phone,
          reference,
          swap_direction: direction,
          status:         'success',
          metadata:       { source: 'wallet_swap', direction },
        });

        fastify.log.info({ walletId: wallet.id, direction, amount }, '[swap] USD↔USDT completed');

        return reply.status(201).send({
          success: true,
          direction,
          ...(direction === 'usd_to_usdt'
            ? { usd_spent: amount, usdt_received: amount }
            : { usdt_spent: amount, usd_received: amount }
          ),
        });
      }

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

        // On-chain mint only for cdf_to_cglt. cglt_to_cdf is a pure internal DB conversion.
        let blockchainTxHash: string | null = null;
        const txId      = crypto.randomUUID();
        const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;

        if (direction === 'cdf_to_cglt' && wallet.blockchain_address) {
          try {
            blockchainTxHash = await mintCGLT(wallet.blockchain_address as string, amount, reference);
          } catch (err) {
            fastify.log.error({ err, walletId: wallet.id, direction, amount }, '[swap] on-chain mint failed');
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

      // ── Internal ledger swap (no blockchain required) ───────
      let amountOut: number;
      let feeAmt:    number;
      let newCgltBalance: number;
      let newUsdtBalance: number;

      if (direction === 'cglt_to_usdt') {
        const gross = amount / CGLT_PER_USDT;
        feeAmt      = Math.round(gross * CGLT_SWAP_FEE * 1e6) / 1e6;
        amountOut   = Math.round((gross - feeAmt) * 1e6) / 1e6;
        newCgltBalance = Math.max(cgltBalance - amount, 0);
        newUsdtBalance = usdtBalance + amountOut;
      } else {
        // usdt_to_cglt
        feeAmt    = Math.round(amount * CGLT_SWAP_FEE * 1e6) / 1e6;
        const net = amount - feeAmt;
        amountOut = Math.round(net * CGLT_PER_USDT * 100) / 100;
        newUsdtBalance = Math.max(usdtBalance - amount, 0);
        newCgltBalance = cgltBalance + amountOut;
      }

      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newCgltBalance, usdt_balance: newUsdtBalance })
        .eq('id', wallet.id);

      const txId      = crypto.randomUUID();
      const reference = `SW-${txId.slice(0, 8).toUpperCase()}`;
      const cgltAmt   = direction === 'cglt_to_usdt' ? amount     : amountOut;
      const usdtAmt   = direction === 'cglt_to_usdt' ? amountOut  : amount;

      await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: wallet.id,
        operator:       'cglt',
        direction:      'swap',
        amount,
        fee:            feeAmt,
        net_amount:     amountOut,
        currency:       'CGLT',
        phone:          wallet.phone,
        reference,
        swap_direction: direction,
        cglt_amount:    cgltAmt,
        usdt_amount:    usdtAmt,
        status:         'success',
        metadata:       { source: 'wallet_swap', direction, rate: CGLT_PER_USDT },
      });

      fastify.log.info(
        { walletId: wallet.id, direction, amountIn: amount, amountOut, feeAmt, rate: CGLT_PER_USDT },
        '[swap] internal ledger swap completed',
      );

      return reply.status(201).send({
        success:    true,
        amount_in:  amount,
        amount_out: amountOut,
        fee:        feeAmt,
        rate:       CGLT_PER_USDT,
      });
    },
  );
};

export default walletSwapRoute;
