/**
 * USDT crypto withdrawal via Binance.
 *
 * POST /v1/wallet/crypto-withdraw
 * GET  /v1/wallet/crypto-withdrawals
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireActiveWallet, walletIdFromRequest } from '../../lib/wallet-auth';
import {
  OnchainConfirmationPendingError,
  OnchainExecutionFailedError,
  sendUsdt,
} from '../../lib/bsc-withdrawal';
import { checkDestinationAddress } from '../../lib/address-guard';

/* ── BSC only — TRC20/ERC20 not yet available ────────────────────────── */
const SUPPORTED_NETWORKS = ['BSC'] as const;
type SupportedNetwork = typeof SUPPORTED_NETWORKS[number];

/* ── Network fee (USDT) ───────────────────────────────────────────────── */
const NETWORK_FEE: Record<SupportedNetwork, number> = { BSC: 0.5 };

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
      config: {
        rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: walletIdFromRequest },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, is_active, usdt_balance, blockchain_address');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload } = auth;
      const wallet = auth.wallet as { id: string; is_active: boolean; usdt_balance: number; blockchain_address?: string };

      const { amount, network, destination_address } = request.body;
      const walletId = payload.wallet_id;

      /* ── 1. Network guard ────────────────────────────────────────────── */
      if (!SUPPORTED_NETWORKS.includes(network)) {
        return reply.status(400).send({
          error:   'NETWORK_NOT_SUPPORTED',
          message: 'Seul le réseau BSC est disponible actuellement',
        });
      }

      /* ── 2. Destination address guard (format + forbidden + contract) ── */
      const guard = await checkDestinationAddress(destination_address, fastify.supabase);
      if (!guard.ok) {
        fastify.log.warn({ walletId, destination_address }, 'Withdrawal blocked — address guard');
        return reply.status(guard.status).send(guard.body);
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

      /* ── 3. Wallet + balance (from auth) ─────────────────────────────── */
      const currentUsdt = Number(wallet.usdt_balance ?? 0);

      if (currentUsdt < amount) {
        return reply.status(402).send({
          error:        'INSUFFICIENT_USDT',
          usdt_balance: currentUsdt,
          required:     amount,
        });
      }

      /* ── 4. Debit USDT balance ───────────────────────────────────────── */
      const withdrawalId = crypto.randomUUID();
      const { error: beginError } = await fastify.supabase.rpc(
        'begin_usdt_onchain_withdrawal',
        {
          p_withdrawal_id: withdrawalId,
          p_user_id: walletId,
          p_amount: amount,
          p_network: network,
          p_destination_address: destination_address,
          p_fee: fee,
        },
      );

      if (beginError) {
        const isInsufficient = beginError.message?.includes('INSUFFICIENT_USDT');
        fastify.log.warn({ err: beginError, walletId }, 'USDT withdrawal creation rejected');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'INSUFFICIENT_USDT' : 'Withdrawal creation failed',
        });
      }

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

        const { error: resolveError } = await fastify.supabase.rpc(
          'resolve_usdt_withdrawal_onchain',
          {
            p_withdrawal_id: withdrawalId,
            p_outcome: 'confirmed',
            p_tx_hash: txHash,
            p_reason: null,
          },
        );
        if (resolveError) throw new OnchainConfirmationPendingError(txHash, resolveError);

        fastify.log.info(
          { withdrawalId, txHash, walletId, network, netAmount, addrMasked },
          'USDT withdrawal sent on-chain (BSC hot wallet)',
        );

        return reply.status(201).send({
          withdrawal_id: withdrawalId,
          status:        'completed',
          net_amount:    netAmount,
          tx_hash:       txHash,
          fee,
          network,
        });
      } catch (err) {
        const reason = (err as Error)?.message ?? 'On-chain error';
        if (err instanceof OnchainConfirmationPendingError) {
          await fastify.supabase.rpc('mark_usdt_withdrawal_pending_check', {
            p_withdrawal_id: withdrawalId,
            p_tx_hash: err.txHash,
            p_reason: reason,
          });
          fastify.log.warn({ err, withdrawalId, walletId, txHash: err.txHash }, 'USDT withdrawal pending on-chain verification');
          return reply.status(202).send({
            withdrawal_id: withdrawalId,
            status: 'pending_onchain_check',
            tx_hash: err.txHash,
            network,
          });
        }

        const txHash = err instanceof OnchainExecutionFailedError ? err.txHash : null;
        const { error: resolveError } = await fastify.supabase.rpc(
          'resolve_usdt_withdrawal_onchain',
          {
            p_withdrawal_id: withdrawalId,
            p_outcome: 'failed',
            p_tx_hash: txHash,
            p_reason: reason,
          },
        );
        if (resolveError) {
          fastify.log.error({ err: resolveError, withdrawalId, walletId }, 'USDT withdrawal failure reconciliation failed');
          return reply.status(500).send({ error: 'Withdrawal reconciliation failed' });
        }

        fastify.log.error({ err, withdrawalId, walletId, txHash }, 'USDT withdrawal failed before or during execution — refunded');
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
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, is_active');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload } = auth;

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
        .eq('user_id', payload.wallet_id)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (error) {
        fastify.log.error({ err: error, walletId: payload.wallet_id }, 'Failed to list withdrawals');
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
