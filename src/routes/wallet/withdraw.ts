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
import { walletFee } from '../../lib/wallet-fees';
import { classifyPayoutFailure, mapClaimError, replayStatusCode } from '../../lib/wallet-withdraw-outcome';

const WALLET_OPERATORS: Channel[] = ['orange', 'airtel', 'afrimoney'];

interface WithdrawBody {
  phone_mm: string;
  operator: Channel;
  amount: number;
  currency?: string;
  idempotency_key?: string;
}

interface ClaimResult {
  idempotent: boolean;
  claimed: boolean;
  transaction_id: string;
  status?: string;
  amount?: number;
  fee?: number;
  net_amount?: number;
  currency?: string;
  new_balance?: number;
}

const WITHDRAW_RESPONSE_PROPS = {
  transaction_id: { type: 'string' },
  status:         { type: 'string' },
  amount:         { type: 'number' },
  fee:            { type: 'number' },
  net_amount:     { type: 'number' },
  currency:       { type: 'string' },
  sandbox:        { type: 'boolean' },
  idempotent:     { type: 'boolean' },
} as const;

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
            currency: { type: 'string', enum: ['CDF'], default: 'CDF' },
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        response: {
          201: { type: 'object', properties: WITHDRAW_RESPONSE_PROPS },
          202: {
            type: 'object',
            properties: { ...WITHDRAW_RESPONSE_PROPS, message: { type: 'string' } },
          },
          409: {
            type: 'object',
            properties: {
              error:          { type: 'string' },
              transaction_id: { type: 'string' },
              status:         { type: 'string' },
              idempotent:     { type: 'boolean' },
              statusCode:     { type: 'number' },
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

      // ── Phone-operator match — BEFORE any debit ───────────────
      // A B2C to an operator whose network doesn't own the phone number
      // is rejected by the operator (MSISDN INCORRECT, code 10401).
      // Checking here means no claim, hence no refund, for this case.
      const phoneOpCheck = validatePhoneOperatorMatch(normalizedPhone, operator);
      if (!phoneOpCheck.ok) {
        fastify.log.warn(
          { walletId, operator, phone: normalizedPhone, detected: phoneOpCheck.detected },
          '[wallet/withdraw] phone-operator mismatch — blocking B2C',
        );
        return reply.status(400).send({
          error: 'OPERATOR_PHONE_MISMATCH',
          message: phoneOpCheck.message,
          detected_operator: phoneOpCheck.detected,
          statusCode: 400,
        });
      }

      const kycLevel = Number(wallet.kyc_level ?? 0);
      const limits   = getLimits(kycLevel);
      const fee            = walletFee(amount);
      const totalDeducted  = Math.round((amount + fee) * 100) / 100;
      const netAmount      = amount;
      const currentBalance = Number(wallet.balance_cdf ?? 0);
      const isSandbox = isSandboxAllowed(env.NODE_ENV, request.headers['x-unipay-mode']);

      const txId      = crypto.randomUUID();
      const reference = `WW-${txId.slice(0, 8).toUpperCase()}`;

      // Idempotency key: header wins, then body, else server-generated so
      // EVERY CDF withdrawal goes through the atomic claim RPC.
      const headerKey = request.headers['idempotency-key'];
      const idempotencyKey =
        (typeof headerKey === 'string' && headerKey.length >= 8 && headerKey.length <= 128 ? headerKey : undefined)
        ?? request.body.idempotency_key
        ?? `srv:${crypto.randomUUID()}`;

      // ── Atomic claim: idempotency + KYC limit + balance + insert + debit ──
      // Replaces wallet_debit_with_kyc_limit + a separate insert. Under
      // the wallet FOR UPDATE lock the RPC either returns the existing
      // transaction for a replayed key, or inserts the 'pending' payout
      // row and debits amount + fee in the same DB transaction.
      const { data: claimData, error: claimError } = await fastify.supabase
        .rpc('wallet_withdraw_claim', {
          p_user_id:         walletId,
          p_total_amount:    totalDeducted,
          p_daily_limit:     limits.withdraw_daily,
          p_idempotency_key: idempotencyKey,
          p_tx_id:           txId,
          p_operator:        operator,
          p_phone:           normalizedPhone,
          p_amount:          amount,
          p_fee:             fee,
          p_net_amount:      netAmount,
          p_currency:        currency,
          p_reference:       reference,
          p_metadata:        { source: 'wallet_withdraw', sandbox: isSandbox },
        });

      if (claimError) {
        const msg = claimError.message ?? '';
        const mapped = mapClaimError(msg);
        if (!mapped) {
          fastify.log.error({ err: claimError, walletId }, '[withdraw] claim RPC failed');
          return reply.status(500).send({ error: 'Debit failed', statusCode: 500 });
        }
        if (mapped.error === 'KYC_LIMIT_EXCEEDED') {
          const match = msg.match(/daily_used ([\d.]+), requested ([\d.]+), limit ([\d.]+)/);
          return reply.status(403).send({
            error:      'KYC_LIMIT_EXCEEDED',
            limit:      match ? Number(match[3]) : limits.withdraw_daily,
            daily_used: match ? Number(match[1]) : undefined,
            kyc_level:  kycLevel,
            statusCode: 403,
          });
        }
        if (mapped.status === 402) {
          return reply.status(402).send({
            error:        mapped.error,
            balance_cdf:  currentBalance,
            required_cdf: totalDeducted,
            statusCode:   402,
          });
        }
        return reply.status(mapped.status).send({ error: mapped.error, statusCode: mapped.status });
      }

      const claim = claimData as ClaimResult;

      // ── Replay: same shape as the first response, idempotent: true ──
      if (claim.idempotent) {
        const status = claim.status ?? 'pending';
        fastify.log.info({ walletId, txId: claim.transaction_id, status }, '[withdraw] idempotent replay');
        if (replayStatusCode(status) === 409) {
          return reply.status(409).send({
            error:          'WITHDRAWAL_ALREADY_FAILED',
            transaction_id: claim.transaction_id,
            status,
            idempotent:     true,
            statusCode:     409,
          });
        }
        return reply.status(201).send({
          transaction_id: claim.transaction_id,
          status,
          amount:         claim.amount,
          fee:            claim.fee,
          net_amount:     claim.net_amount,
          currency:       claim.currency,
          sandbox:        false,
          idempotent:     true,
        });
      }

      fastify.log.info({ walletId, txId, claim }, '[withdraw] claim succeeded');

      // ── Sandbox path ──────────────────────────────────────────
      if (isSandbox) {
        const mockRef = sandboxPayout(amount).avada_transaction_id;

        await fastify.supabase.from('transactions')
          .update({ status: 'success', avada_transaction_id: mockRef })
          .eq('id', txId);

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
          idempotent:     false,
        });
      }

      // ── Live path ─────────────────────────────────────────────
      const service = getProviderService(operator);

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
          idempotent:     false,
        });
      } catch (err) {
        const errMsg = (err as Error)?.message ?? 'unknown error';
        const outcome = classifyPayoutFailure(err);

        if (outcome.kind === 'definitive') {
          // Provider provably created nothing → the single atomic
          // refund path (tx lock → wallet credit amount+fee → 'failed').
          // A callback racing us hits already_terminal and credits nothing.
          fastify.log.error(
            { err: errMsg, txId, operator, outcome },
            '[withdraw] provider rejected payout — refunding via wallet_withdraw_fail_and_refund',
          );
          const { data: refund, error: refundErr } = await fastify.supabase
            .rpc('wallet_withdraw_fail_and_refund', { p_tx_id: txId, p_reason: outcome.reason });
          if (refundErr) {
            fastify.log.error(
              { err: refundErr, txId },
              '[withdraw] refund RPC failed — tx left pending for reconciliation',
            );
          } else {
            fastify.log.info({ txId, refund }, '[withdraw] refunded');
          }
          return reply.status(502).send({
            error: 'Provider service unavailable',
            statusCode: 502,
          });
        }

        // Ambiguous (timeout / network / 5xx / unreadable / unknown
        // code): the payout MAY exist at Unipesa. NO refund here — the
        // row stays 'pending' (debited) until the reconciliation worker
        // resolves it via /status by order_id = reference.
        fastify.log.error(
          { err: errMsg, txId, operator, reference, outcome },
          '[withdraw] provider outcome ambiguous — NOT refunding, awaiting reconciliation',
        );
        await fastify.supabase
          .from('transactions')
          .update({
            metadata: {
              source: 'wallet_withdraw',
              sandbox: false,
              error: 'PROVIDER_AMBIGUOUS',
              provider_error: errMsg,
              awaiting_reconciliation: true,
            },
          })
          .eq('id', txId);

        return reply.status(202).send({
          transaction_id: txId,
          status:         'pending',
          amount,
          fee,
          net_amount:     netAmount,
          currency,
          sandbox:        false,
          idempotent:     false,
          message:        'Withdrawal is being verified. Your balance will be updated once the operator confirms.',
        });
      }
    },
  );
};

export default walletWithdrawRoute;
