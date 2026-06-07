import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { getProviderService } from '../../services/index';
import { sandboxCollection } from '../../services/avada';
import type { Channel } from '../../types/payment';
import { getLimits } from '../../utils/kyc-limits';

// Wallet-supported MM operators (Vodacash pending due diligence, USDT not in wallet scope)
const WALLET_OPERATORS: Channel[] = ['orange', 'airtel', 'afrimoney'];

const FEE_RATE = 0.03;

interface DepositBody {
  phone_mm: string;
  operator: Channel;
  amount: number;
  currency?: string;
}

const walletDepositRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: DepositBody }>(
    '/wallet/deposit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone_mm', 'operator', 'amount'],
          properties: {
            phone_mm: { type: 'string', pattern: '^(0|\\+?[1-9])\\d{6,14}$' },
            operator: { type: 'string', enum: WALLET_OPERATORS },
            amount:   { type: 'number', minimum: 100 },
            currency: { type: 'string', minLength: 3, maxLength: 3, default: 'CDF' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              transaction_id: { type: 'string' },
              status:         { type: 'string' },
              amount:         { type: 'number' },
              fee:            { type: 'number' },
              net_amount:     { type: 'number' },
              currency:       { type: 'string' },
              sandbox:        { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!walletPayload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { phone_mm, operator, amount, currency = 'CDF' } = request.body;
      const walletId = walletPayload.wallet_id;
      const normalizedPhone = phone_mm.replace(/\s/g, '');

      if (!/^\+243[0-9]{9}$/.test(normalizedPhone)) {
        return reply.status(400).send({
          error: 'INVALID_PHONE',
          message: 'Numéro DRC invalide. Format requis : +243XXXXXXXXX (9 chiffres après +243)',
        });
      }

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, is_active, balance_cdf, kyc_level')
        .eq('id', walletId)
        .maybeSingle();

      if (!wallet?.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      // ── KYC daily deposit limit check ─────────────────────
      const kycLevel = Number(wallet.kyc_level ?? 0);
      const limits   = getLimits(kycLevel);
      const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
      const { data: todayRows } = await fastify.supabase
        .from('transactions')
        .select('amount')
        .eq('wallet_user_id', walletId)
        .eq('direction', 'collect')
        .in('status', ['processing', 'success'])
        .gte('created_at', dayStart.toISOString());
      const dailyUsed = (todayRows ?? []).reduce((s, r) => s + Number(r.amount), 0);
      if (dailyUsed + amount > limits.deposit_daily) {
        return reply.status(403).send({
          error:      'KYC_LIMIT_EXCEEDED',
          limit:      limits.deposit_daily,
          daily_used: dailyUsed,
          kyc_level:  kycLevel,
          statusCode: 403,
        });
      }

      // Sandbox detection via header
      const isSandbox = request.headers['x-unipay-mode'] === 'sandbox';

      const fee       = Math.round(amount * FEE_RATE * 100) / 100;
      const netAmount = Math.round((amount - fee) * 100) / 100;
      const txId      = crypto.randomUUID();
      const reference = `WD-${txId.slice(0, 8).toUpperCase()}`;

      // ── Sandbox path ──────────────────────────────────────────
      if (isSandbox) {
        const mockRef = sandboxCollection(amount).avada_transaction_id;

        await fastify.supabase.from('transactions').insert({
          id:                   txId,
          wallet_user_id:       walletId,
          operator,
          direction:            'collect',
          amount,
          fee,
          net_amount:           netAmount,
          currency,
          phone:                normalizedPhone,
          reference,
          avada_transaction_id: mockRef,
          status:               'success',
          metadata:             { sandbox: true, source: 'wallet_deposit' },
        });

        // Credit balance immediately in sandbox
        await fastify.supabase
          .from('wallet_users')
          .update({ balance_cdf: Number(wallet.balance_cdf ?? 0) + netAmount })
          .eq('id', walletId);

        fastify.log.info({ txId, walletId, isSandbox: true }, 'Wallet deposit (sandbox)');

        return reply.status(201).send({
          transaction_id: txId,
          status:         'success',
          amount,
          fee,
          net_amount:     netAmount,
          currency,
          sandbox:        true,
        });
      }

      // ── Live path ─────────────────────────────────────────────
      // 1. Insert transaction as pending
      const { error: insertError } = await fastify.supabase
        .from('transactions')
        .insert({
          id:             txId,
          wallet_user_id: walletId,
          operator,
          direction:      'collect',
          amount,
          fee,
          net_amount:     netAmount,
          currency,
          phone:          normalizedPhone,
          reference,
          status:         'pending',
          metadata:       { source: 'wallet_deposit' },
        });

      if (insertError) {
        fastify.log.error({ err: insertError, txId }, 'Wallet deposit insert failed');
        return reply.status(500).send({ error: 'Failed to create deposit', statusCode: 500 });
      }

      // 2. Call provider (collection from user's mobile money)
      const service = getProviderService(operator);
      try {
        const providerRes = await service.initiatePayment({
          transaction_id: txId,
          amount,
          currency,
          phone:          normalizedPhone,
          direction:      'collect',
          reference,
        });

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing', avada_transaction_id: providerRes.provider_ref })
          .eq('id', txId);

        // TODO Phase 2: credit wallet balance via /v1/payment/callback on status='success'

        fastify.log.info({ txId, walletId, operator }, 'Wallet deposit initiated');

        return reply.status(201).send({
          transaction_id: txId,
          status:         'processing',
          amount,
          fee,
          net_amount:     netAmount,
          currency,
          sandbox:        false,
        });
      } catch (err) {
        fastify.log.error({ err, txId, operator }, 'Wallet deposit provider error');
        await fastify.supabase
          .from('transactions')
          .update({ status: 'failed' })
          .eq('id', txId);
        return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
      }
    },
  );
};

export default walletDepositRoute;
