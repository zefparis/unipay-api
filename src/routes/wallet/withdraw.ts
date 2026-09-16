import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireActiveWallet, walletIdFromRequest } from '../../lib/wallet-auth';
import { getProviderService } from '../../services/index';
import { sendWalletWithdrawalEmail } from '../../services/email';
import { notify } from '../../utils/push';
import { sandboxPayout } from '../../services/avada';
import type { Channel } from '../../types/payment';
import { getLimits } from '../../utils/kyc-limits';
import { isSandboxAllowed } from '../../lib/sandbox-mode';
import { validatePhoneOperatorMatch } from '../../lib/phone-normalization';

const WALLET_OPERATORS: Channel[] = ['orange', 'airtel', 'afrimoney'];

const FEE_RATE = 0.03;

interface WithdrawBody {
  phone_mm: string;
  operator: Channel;
  amount: number;
  currency?: string;
}

const walletWithdrawRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: WithdrawBody }>(
    '/wallet/withdraw',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: walletIdFromRequest } },
      schema: {
        body: {
          type: 'object',
          required: ['phone_mm', 'operator', 'amount'],
          properties: {
            phone_mm: { type: 'string', pattern: '^\\+?[1-9]\\d{7,14}$' },
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
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, is_active, balance_cdf, kyc_level, blockchain_address, email, full_name, lang');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload: walletPayload } = auth;
      const wallet = auth.wallet as { id: string; is_active: boolean; balance_cdf: number; kyc_level: number; blockchain_address: string; email: string; full_name: string; lang: string };

      const { phone_mm, operator, amount, currency = 'CDF' } = request.body;
      const walletId = walletPayload.wallet_id;
      const normalizedPhone = phone_mm.replace(/\s/g, '');

      if (!/^\+243[0-9]{9}$/.test(normalizedPhone)) {
        return reply.status(400).send({
          error: 'INVALID_PHONE',
          message: 'Invalid DRC number. Required format: +243XXXXXXXXX (9 digits after +243)',
        });
      }

      // ── Atomic KYC daily limit check + balance debit (M3) ──────
      // Previously this was a TOCTOU: the daily limit was checked in
      // a SELECT, then the balance debited in a separate UPDATE. Two
      // concurrent requests could both pass the limit check before
      // either debit was visible. Now both checks + the debit happen
      // atomically in a single RPC (FOR UPDATE on wallet_users).
      const kycLevel = Number(wallet.kyc_level ?? 0);
      const limits   = getLimits(kycLevel);
      const fee            = Math.round(amount * FEE_RATE * 100) / 100;
      const totalDeducted  = Math.round((amount + fee) * 100) / 100;
      const netAmount      = amount;
      const currentBalance = Number(wallet.balance_cdf ?? 0);

      const { data: debitResult, error: debitError } = await fastify.supabase
        .rpc('wallet_debit_with_kyc_limit', {
          p_user_id: walletId,
          p_amount: totalDeducted,
          p_daily_limit: limits.withdraw_daily,
        });

      if (debitError) {
        const msg = debitError.message ?? '';
        if (msg.includes('KYC_LIMIT_EXCEEDED')) {
          const match = msg.match(/daily_used ([\d.]+), requested ([\d.]+), limit ([\d.]+)/);
          return reply.status(403).send({
            error:      'KYC_LIMIT_EXCEEDED',
            limit:      match ? Number(match[3]) : limits.withdraw_daily,
            daily_used: match ? Number(match[1]) : undefined,
            kyc_level:  kycLevel,
            statusCode: 403,
          });
        }
        if (msg.includes('INSUFFICIENT_FUNDS')) {
          return reply.status(402).send({
            error:        'Insufficient balance',
            balance_cdf:  currentBalance,
            required_cdf: totalDeducted,
            statusCode:   402,
          });
        }
        if (msg.includes('WALLET_SUSPENDED')) {
          return reply.status(403).send({
            error:      'Account is suspended',
            statusCode: 403,
          });
        }
        fastify.log.error({ err: debitError, walletId }, '[withdraw] Atomic debit+KYC failed');
        return reply.status(500).send({ error: 'Debit failed', statusCode: 500 });
      }

      const isSandbox = isSandboxAllowed(env.NODE_ENV, request.headers['x-unipay-mode']);

      const txId      = crypto.randomUUID();
      const reference = `WW-${txId.slice(0, 8).toUpperCase()}`;

      fastify.log.info(
        { walletId, txId, debitResult },
        '[withdraw] Atomic KYC+debit succeeded',
      );

      // ── Sandbox path ──────────────────────────────────────────
      if (isSandbox) {
        const mockRef = sandboxPayout(amount).avada_transaction_id;

        await fastify.supabase.from('transactions').insert({
          id:                   txId,
          wallet_user_id:       walletId,
          operator,
          direction:            'payout',
          amount,
          fee,
          net_amount:           netAmount,
          currency,
          phone:                normalizedPhone,
          reference,
          avada_transaction_id: mockRef,
          blockchain_tx_hash:   null,
          status:               'success',
          metadata:             { sandbox: true, source: 'wallet_withdraw' },
        });

        fastify.log.info({ txId, walletId, isSandbox: true }, 'Wallet withdraw (sandbox)');

        notify({
          userId: walletId, type: 'withdrawal',
          titleFr: '💸 Retrait effectué', titleEn: '💸 Withdrawal completed',
          bodyFr: `${amount} ${currency} envoyé vers ${normalizedPhone}`,
          bodyEn: `${amount} ${currency} sent to ${normalizedPhone}`,
          data: { amount, currency, phone: normalizedPhone, operator },
        }).catch(() => {});

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
      const { error: insertError } = await fastify.supabase
        .from('transactions')
        .insert({
          id:             txId,
          wallet_user_id: walletId,
          operator,
          direction:      'payout',
          amount,
          fee,
          net_amount:     netAmount,
          currency,
          phone:          normalizedPhone,
          reference,
          blockchain_tx_hash: null,
          status:         'pending',
          metadata:       { source: 'wallet_withdraw' },
        });

      if (insertError) {
        // Compensate — refund deducted balance
        await fastify.supabase
          .rpc('wallet_credit_cdf', { p_user_id: walletId, p_amount: totalDeducted });
        fastify.log.error({ err: insertError, txId }, 'Wallet withdraw insert failed — balance refunded');
        return reply.status(500).send({ error: 'Failed to create withdrawal', statusCode: 500 });
      }

      // Call provider (payout to user's mobile money)
      const service = getProviderService(operator);

      // ── Phone-operator match validation ─────────────────────
      // A B2C to an operator whose network doesn't own the phone number
      // is rejected by the operator (MSISDN INCORRECT, code 10401).
      // Detect this BEFORE sending the doomed B2C to save a round-trip
      // and give the caller a clear, actionable error.
      const phoneOpCheck = validatePhoneOperatorMatch(normalizedPhone, operator);
      if (!phoneOpCheck.ok) {
        fastify.log.warn(
          { txId, walletId, operator, phone: normalizedPhone, detected: phoneOpCheck.detected },
          '[wallet/withdraw] phone-operator mismatch — blocking B2C',
        );
        // Refund the deducted balance
        await fastify.supabase.rpc('wallet_credit_cdf', { p_user_id: walletId, p_amount: totalDeducted });
        await fastify.supabase.from('transactions')
          .update({ status: 'failed', metadata: { source: 'wallet_withdraw', error: 'OPERATOR_PHONE_MISMATCH', detected_operator: phoneOpCheck.detected } })
          .eq('id', txId);
        return reply.status(400).send({
          error: 'OPERATOR_PHONE_MISMATCH',
          message: phoneOpCheck.message,
          detected_operator: phoneOpCheck.detected,
          statusCode: 400,
        });
      }

      try {
        const providerRes = await service.initiatePayment({
          transaction_id: txId,
          amount,
          currency,
          phone:          normalizedPhone,
          direction:      'payout',
          reference,
        });

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing', avada_transaction_id: providerRes.provider_ref })
          .eq('id', txId);

        fastify.log.info({ txId, walletId, operator }, 'Wallet withdrawal initiated');

        const wUser = wallet as unknown as { email?: string; full_name?: string; lang?: string };

        notify({
          userId: walletId, type: 'withdrawal',
          titleFr: '💸 Retrait en cours', titleEn: '💸 Withdrawal processing',
          bodyFr: `${amount} ${currency} — envoyé vers ${normalizedPhone} (${operator})`,
          bodyEn: `${amount} ${currency} — sent to ${normalizedPhone} (${operator})`,
          data: { amount, currency, phone: normalizedPhone, operator },
          lang: wUser?.lang,
        }).catch(() => {});
        if (wUser?.email) {
          sendWalletWithdrawalEmail({
            to: wUser.email, name: wUser.full_name ?? '', amount: String(amount),
            currency, phone: normalizedPhone, operator, txRef: reference,
            lang: wUser.lang ?? 'fr',
          });
        }

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
        // Provider failed — refund balance and mark transaction failed
        const errMsg = (err as Error)?.message ?? 'unknown error';
        fastify.log.error({ err: errMsg, txId, operator }, 'Wallet withdraw provider error — refunding');
        await fastify.supabase
          .rpc('wallet_credit_cdf', { p_user_id: walletId, p_amount: totalDeducted });
        await fastify.supabase
          .from('transactions')
          .update({ status: 'failed', metadata: { source: 'wallet_withdraw', error: 'PROVIDER_FAILED', provider_error: errMsg } })
          .eq('id', txId);
        return reply.status(502).send({
          error: 'Provider service unavailable',
          detail: errMsg,
          statusCode: 502,
        });
      }
    },
  );
};

export default walletWithdrawRoute;
