/**
 * USDT crypto withdrawal via Binance.
 *
 * POST /v1/wallet/crypto-withdraw
 * GET  /v1/wallet/crypto-withdrawals
 */

import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { sendUsdt } from '../../lib/bsc-withdrawal';

/* ── BSC only — TRC20/ERC20 not yet available ────────────────────────── */
const SUPPORTED_NETWORKS = ['BSC'] as const;
type SupportedNetwork = typeof SUPPORTED_NETWORKS[number];

/* ── Network fee (USDT) ───────────────────────────────────────────────── */
const NETWORK_FEE: Record<SupportedNetwork, number> = { BSC: 0.5 };

/* ── Address regex (BSC = EVM) ─────────────────────────────────────────── */
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

/* ── Minimum net withdrawal (USDT) ────────────────────────────────────── */
const MIN_NET = 5;

interface CryptoWithdrawBody {
  amount:              number;
  network:             SupportedNetwork;
  destination_address: string;
}

const walletCryptoWithdrawRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/crypto-withdraw ─────────────────────────────────── */
  fastify.post<{ Body: CryptoWithdrawBody }>(
    '/wallet/crypto-withdraw',
    {
      schema: {
        body: {
          type:       'object',
          required:   ['amount', 'network', 'destination_address'],
          properties: {
            amount:              { type: 'number', exclusiveMinimum: 0 },
            network:             { type: 'string', enum: ['BSC'] },
            destination_address: { type: 'string', minLength: 10, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured' });
      }

      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const { amount, network, destination_address } = request.body;
      const walletId = wp.wallet_id;

      /* ── 1. Network guard ────────────────────────────────────────────── */
      if (!SUPPORTED_NETWORKS.includes(network)) {
        return reply.status(400).send({
          error:   'NETWORK_NOT_SUPPORTED',
          message: 'Seul le réseau BSC est disponible actuellement',
        });
      }

      /* ── 2. Validate BSC address format ─────────────────────────────── */
      if (!EVM_ADDR.test(destination_address)) {
        return reply.status(400).send({
          error:   'INVALID_ADDRESS',
          message: 'EVM address must be a valid 0x hex address (42 chars)',
        });
      }

      /* ── Check hot wallet is configured ────────────────────────────── */
      if (!env.HOT_WALLET_USDT_PRIVATE_KEY) {
        return reply.status(503).send({ error: 'Crypto withdrawal not configured' });
      }

      /* ── 2. Fee + net amount ─────────────────────────────────────────── */
      const fee       = NETWORK_FEE[network];
      const netAmount = Math.round((amount - fee) * 1e6) / 1e6;

      if (netAmount < MIN_NET) {
        return reply.status(400).send({
          error:      'AMOUNT_TOO_LOW',
          message:    `Minimum withdrawal after fee is ${MIN_NET} USDT. Fee for ${network}: ${fee} USDT.`,
          fee,
          min_gross:  fee + MIN_NET,
        });
      }

      /* ── 3. Fetch wallet + balance ───────────────────────────────────── */
      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, is_active, usdt_balance, email, full_name, lang')
        .eq('id', walletId)
        .maybeSingle();

      if (!wallet?.is_active) {
        return reply.status(403).send({ error: 'Account is suspended' });
      }

      const currentUsdt = Number(wallet.usdt_balance ?? 0);

      if (currentUsdt < amount) {
        return reply.status(402).send({
          error:        'INSUFFICIENT_USDT',
          usdt_balance: currentUsdt,
          required:     amount,
        });
      }

      /* ── 4. Debit USDT balance ───────────────────────────────────────── */
      const { error: debitErr } = await fastify.supabase
        .from('wallet_users')
        .update({ usdt_balance: currentUsdt - amount })
        .eq('id', walletId)
        .gte('usdt_balance', amount); // atomic guard

      if (debitErr) {
        fastify.log.error({ err: debitErr, walletId }, 'USDT debit failed');
        return reply.status(500).send({ error: 'Debit failed' });
      }

      /* ── 5. Insert withdrawal_requests row ──────────────────────────── */
      const { data: wrRow, error: insertErr } = await fastify.supabase
        .from('withdrawal_requests')
        .insert({
          user_id:             walletId,
          amount,
          network,
          destination_address,
          fee,
          status:              'pending',
        })
        .select('id')
        .single();

      if (insertErr || !wrRow) {
        // Compensate — refund
        await fastify.supabase
          .from('wallet_users')
          .update({ usdt_balance: currentUsdt })
          .eq('id', walletId);
        fastify.log.error({ err: insertErr, walletId }, 'withdrawal_requests insert failed — refunded');
        return reply.status(500).send({ error: 'Failed to create withdrawal record' });
      }

      const withdrawalId = wrRow.id;
      const addrMasked   = `${destination_address.slice(0, 6)}…${destination_address.slice(-4)}`;

      fastify.log.info(
        { withdrawalId, walletId, network, amount, fee, netAmount, addrMasked },
        'USDT withdrawal — sending on-chain (BSC hot wallet)',
      );

      /* ── 6. Send on-chain via hot wallet ─────────────────────────────── */
      try {
        const { txHash } = await sendUsdt({
          to:     destination_address,
          amount: netAmount,
        });

        await fastify.supabase
          .from('withdrawal_requests')
          .update({
            tx_hash:    txHash,
            status:     'processing',
            updated_at: new Date().toISOString(),
          })
          .eq('id', withdrawalId);

        fastify.log.info(
          { withdrawalId, txHash, walletId, network, netAmount, addrMasked },
          'USDT withdrawal sent on-chain (BSC hot wallet)',
        );

        return reply.status(201).send({
          withdrawal_id: withdrawalId,
          status:        'processing',
          net_amount:    netAmount,
          tx_hash:       txHash,
          fee,
          network,
        });
      } catch (err) {
        const reason = (err as Error)?.message ?? 'On-chain error';
        fastify.log.error({ err, withdrawalId, walletId }, 'BSC hot-wallet withdrawal failed — refunding');

        // Compensate — refund balance
        await fastify.supabase
          .from('wallet_users')
          .update({ usdt_balance: currentUsdt })
          .eq('id', walletId);

        // Mark failed
        await fastify.supabase
          .from('withdrawal_requests')
          .update({
            status:         'failed',
            failure_reason: reason,
            updated_at:     new Date().toISOString(),
          })
          .eq('id', withdrawalId);

        const status = reason === 'INSUFFICIENT_HOT_WALLET_BALANCE' ? 503
                     : reason === 'INSUFFICIENT_GAS'                 ? 503
                     : 502;
        return reply.status(status).send({ error: reason });
      }
    },
  );

  /* ── GET /v1/wallet/crypto-withdrawals ───────────────────────────────── */
  fastify.get<{ Querystring: { page?: number } }>(
    '/wallet/crypto-withdrawals',
    {
      schema: {
        querystring: {
          type:       'object',
          properties: { page: { type: 'integer', minimum: 1, default: 1 } },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });

      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const page     = Number(request.query.page ?? 1);
      const pageSize = 20;
      const from     = (page - 1) * pageSize;
      const to       = from + pageSize - 1;

      const { data, error, count } = await fastify.supabase
        .from('withdrawal_requests')
        .select(
          'id, amount, network, destination_address, fee, status, binance_withdraw_id, tx_hash, failure_reason, created_at, updated_at',
          { count: 'exact' },
        )
        .eq('user_id', wp.wallet_id)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) {
        fastify.log.error({ err: error, walletId: wp.wallet_id }, 'Failed to list withdrawals');
        return reply.status(500).send({ error: 'Failed to list withdrawals' });
      }

      return {
        data:        data ?? [],
        total:       count ?? 0,
        page,
        page_size:   pageSize,
        total_pages: Math.ceil((count ?? 0) / pageSize),
      };
    },
  );
};

export default walletCryptoWithdrawRoute;
