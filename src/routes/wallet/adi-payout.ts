/**
 * ADI Chain payout routes.
 *
 * A) POST /v1/adi/payout-request  — wallet JWT, called by unipay-congo
 *    User requests a CDF withdrawal that will be settled via USDC on ADI Chain.
 *    Flow:
 *      1. Debit user balance_cdf atomically (wallet_debit RPC)
 *      2. Insert adi_withdrawal_requests {status: 'pending'}
 *      3. POST to PredictStreet payout webhook (HMAC-signed)
 *      4. Return { ok, withdrawal_id }
 *
 * B) POST /v1/adi/payout-status   — HMAC-signed, called BY PredictStreet
 *    PredictStreet updates us after sending (or failing) the USDC on-chain.
 *    Flow:
 *      1. Verify HMAC signature
 *      2. Update adi_withdrawal_requests.tx_hash + status
 *      3a. status='sent'   → waitForConfirmations(12) then Avada B2C CDF payout
 *      3b. status='failed' → refund user balance_cdf
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { waitForConfirmations } from '../../lib/adi-withdrawal';
import { initiatePayout } from '../../services/avada';

/* ── HMAC helpers ───────────────────────────────────────────────────────────── */

function signHmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function verifyHmac(rawBody: string, signature: string, secret: string): boolean {
  const expected = signHmac(rawBody, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.toLowerCase()),
      Buffer.from(expected.toLowerCase()),
    );
  } catch {
    return false;
  }
}

/* ── CDF payout fee rate (mirrors withdraw.ts) ─────────────────────────────── */
const FEE_RATE = 0.03;

/* ── Allowed CDF MM operators ───────────────────────────────────────────────── */
const ALLOWED_OPERATORS = ['orange', 'airtel', 'afrimoney'] as const;
type CdfOperator = typeof ALLOWED_OPERATORS[number];

/* ── Fastify plugin ─────────────────────────────────────────────────────────── */
const adiPayoutRoute: FastifyPluginAsync = async (fastify) => {

  /* ──────────────────────────────────────────────────────────────────────────
   * A) POST /v1/adi/payout-request
   * Auth: wallet JWT
   * Body: { amount_cdf, mobile_number, operator }
   * ────────────────────────────────────────────────────────────────────────── */
  fastify.post<{
    Body: { amount_cdf: number; mobile_number: string; operator: CdfOperator };
  }>(
    '/adi/payout-request',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['amount_cdf', 'mobile_number', 'operator'],
          properties: {
            amount_cdf:    { type: 'number', minimum: 100 },
            mobile_number: { type: 'string', pattern: '^\\+243[0-9]{9}$' },
            operator:      { type: 'string', enum: [...ALLOWED_OPERATORS] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'auth_not_configured' });

      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      if (!env.PREDICTSTREET_PAYOUT_URL) {
        return reply.status(503).send({ error: 'adi_payout_not_configured' });
      }
      if (!env.PREDICTSTREET_SERVER_SECRET) {
        return reply.status(503).send({ error: 'adi_payout_secret_not_configured' });
      }

      const { amount_cdf, mobile_number, operator } = request.body;
      const walletId = wp.wallet_id;

      /* 1. Verify wallet is active */
      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, is_active, balance_cdf')
        .eq('id', walletId)
        .maybeSingle();

      if (!wallet?.is_active) {
        return reply.status(403).send({ error: 'account_suspended' });
      }

      const fee        = Math.round(amount_cdf * FEE_RATE);
      const totalDebit = amount_cdf + fee;

      if (Number(wallet.balance_cdf ?? 0) < totalDebit) {
        return reply.status(402).send({
          error:       'insufficient_balance',
          balance_cdf: Number(wallet.balance_cdf ?? 0),
          required:    totalDebit,
        });
      }

      /* 2. Atomic debit via RPC */
      const { error: debitErr } = await fastify.supabase
        .rpc('wallet_debit', { p_user_id: walletId, p_amount: totalDebit });

      if (debitErr) {
        const isInsufficient = debitErr.message?.includes('INSUFFICIENT_FUNDS');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'insufficient_balance' : 'debit_failed',
        });
      }

      /* 3. Insert adi_withdrawal_requests */
      const withdrawalId = crypto.randomUUID();
      const reference    = `AWR-${withdrawalId.slice(0, 8).toUpperCase()}`;

      const { error: insertErr } = await fastify.supabase
        .from('adi_withdrawal_requests')
        .insert({
          id:            withdrawalId,
          user_id:       walletId,
          amount_cdf,
          fee,
          mobile_number,
          operator,
          reference,
          status:        'pending',
          created_at:    new Date().toISOString(),
        });

      if (insertErr) {
        fastify.log.error({ err: insertErr, walletId }, '[adi-payout] insert failed — refunding');
        await fastify.supabase
          .from('wallet_users')
          .update({ balance_cdf: Number(wallet.balance_cdf) })
          .eq('id', walletId);
        return reply.status(500).send({ error: 'db_insert_failed' });
      }

      /* 4. Notify PredictStreet payout webhook */
      const psPayload = JSON.stringify({
        withdrawal_id: withdrawalId,
        reference,
        amount_cdf,
        mobile_number,
        operator,
        timestamp: Math.floor(Date.now() / 1000),
      });
      const psSignature = signHmac(psPayload, env.PREDICTSTREET_SERVER_SECRET!);

      try {
        const psRes = await fetch(env.PREDICTSTREET_PAYOUT_URL!, {
          method:  'POST',
          headers: {
            'Content-Type':              'application/json',
            'X-UniPay-Signature':        psSignature,
          },
          body:    psPayload,
          signal:  AbortSignal.timeout(10_000),
        });

        if (!psRes.ok) {
          const errText = await psRes.text().catch(() => '');
          fastify.log.warn(
            { withdrawalId, status: psRes.status, errText },
            '[adi-payout] PredictStreet payout webhook returned non-2xx — withdrawal remains pending',
          );
          // Don't fail the request — PS may retry; record remains pending
        } else {
          fastify.log.info({ withdrawalId }, '[adi-payout] PredictStreet notified successfully');
          await fastify.supabase
            .from('adi_withdrawal_requests')
            .update({ status: 'notified' })
            .eq('id', withdrawalId);
        }
      } catch (err) {
        fastify.log.warn({ err, withdrawalId }, '[adi-payout] PredictStreet webhook call failed — pending');
      }

      return reply.send({ ok: true, withdrawal_id: withdrawalId, reference });
    },
  );

  /* ──────────────────────────────────────────────────────────────────────────
   * B) POST /v1/adi/payout-status
   * HMAC-signed by PredictStreet — updates us after USDC is sent/failed
   * Body: { payout_id, tx_hash?, status: 'sent'|'failed', reason? }
   * ────────────────────────────────────────────────────────────────────────── */
  fastify.post<{
    Body: {
      payout_id: string;
      tx_hash?:  string;
      status:    'sent' | 'failed';
      reason?:   string;
    };
  }>(
    '/adi/payout-status',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['payout_id', 'status'],
          properties: {
            payout_id: { type: 'string', minLength: 1 },
            tx_hash:   { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
            status:    { type: 'string', enum: ['sent', 'failed'] },
            reason:    { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.PREDICTSTREET_SERVER_SECRET) {
        return reply.status(503).send({ error: 'adi_payout_not_configured' });
      }

      /* 1. HMAC verification */
      const signature = (request.headers['x-predictstreet-signature'] ?? '') as string;
      if (!signature) return reply.status(401).send({ error: 'missing_signature' });

      const rawBody = JSON.stringify(request.body);
      if (!verifyHmac(rawBody, signature, env.PREDICTSTREET_SERVER_SECRET)) {
        fastify.log.warn({ payout_id: request.body?.payout_id }, '[adi-payout-status] HMAC failed');
        return reply.status(401).send({ error: 'invalid_signature' });
      }

      const { payout_id, tx_hash, status, reason } = request.body;

      /* 2. Find the withdrawal request */
      const { data: wr } = await fastify.supabase
        .from('adi_withdrawal_requests')
        .select('id, user_id, amount_cdf, mobile_number, operator, status, reference')
        .eq('id', payout_id)
        .maybeSingle();

      if (!wr) {
        fastify.log.warn({ payout_id }, '[adi-payout-status] withdrawal not found');
        return reply.status(404).send({ error: 'withdrawal_not_found' });
      }

      /* Idempotency guard */
      if (wr.status === 'completed' || wr.status === 'refunded') {
        return reply.send({ ok: true, status: 'already_finalized' });
      }

      /* 3a. FAILED — refund user */
      if (status === 'failed') {
        fastify.log.warn({ payout_id, reason }, '[adi-payout-status] PredictStreet reported failure — refunding');

        await fastify.supabase
          .from('adi_withdrawal_requests')
          .update({ status: 'failed', failure_reason: reason ?? 'ps_failed', updated_at: new Date().toISOString() })
          .eq('id', payout_id);

        const { data: walletRow } = await fastify.supabase
          .from('wallet_users')
          .select('balance_cdf')
          .eq('id', wr.user_id)
          .single();

        const feeForRefund = Math.round(Number(wr.amount_cdf) * FEE_RATE);
        const refundTotal  = Number(wr.amount_cdf) + feeForRefund;

        await fastify.supabase
          .from('wallet_users')
          .update({ balance_cdf: Number(walletRow?.balance_cdf ?? 0) + refundTotal })
          .eq('id', wr.user_id);

        await fastify.supabase
          .from('adi_withdrawal_requests')
          .update({ status: 'refunded' })
          .eq('id', payout_id);

        fastify.log.info({ payout_id, refundTotal, userId: wr.user_id }, '[adi-payout-status] refunded');
        return reply.send({ ok: true, action: 'refunded' });
      }

      /* 3b. SENT — wait 12 confirmations then trigger Avada B2C payout */
      if (!tx_hash) {
        return reply.status(400).send({ error: 'tx_hash_required_when_sent' });
      }

      await fastify.supabase
        .from('adi_withdrawal_requests')
        .update({ tx_hash, status: 'confirming', updated_at: new Date().toISOString() })
        .eq('id', payout_id);

      fastify.log.info({ payout_id, tx_hash }, '[adi-payout-status] USDC sent — awaiting 12 confirmations');

      /* Respond immediately; confirmation + CDF payout run in background */
      reply.send({ ok: true, action: 'confirming' });

      /* Background: wait for on-chain confirmations then pay CDF */
      setImmediate(async () => {
        try {
          const confirmed = await waitForConfirmations(tx_hash, 12);

          if (!confirmed) {
            fastify.log.error({ payout_id, tx_hash }, '[adi-payout-status] 12-conf timeout — manual review needed');
            await fastify.supabase
              .from('adi_withdrawal_requests')
              .update({ status: 'confirm_timeout', updated_at: new Date().toISOString() })
              .eq('id', payout_id);
            return;
          }

          /* Trigger Avada B2C CDF payout */
          const avadaRef = `ADP-${payout_id.slice(0, 8).toUpperCase()}`;
          let avadaId: string;
          try {
            const result = await initiatePayout(
              wr.operator,
              wr.mobile_number,
              Number(wr.amount_cdf),
              avadaRef,
              'CDF',
            );
            avadaId = result.avada_transaction_id;
          } catch (err) {
            fastify.log.error({ err, payout_id }, '[adi-payout-status] Avada B2C failed — manual payout required');
            await fastify.supabase
              .from('adi_withdrawal_requests')
              .update({ status: 'avada_failed', updated_at: new Date().toISOString() })
              .eq('id', payout_id);
            return;
          }

          await fastify.supabase
            .from('adi_withdrawal_requests')
            .update({
              status:               'completed',
              avada_transaction_id: avadaId,
              updated_at:           new Date().toISOString(),
            })
            .eq('id', payout_id);

          fastify.log.info(
            { payout_id, tx_hash, avadaId, amount_cdf: wr.amount_cdf, mobile: wr.mobile_number },
            '[adi-payout-status] CDF payout triggered via Avada',
          );
        } catch (err) {
          fastify.log.error({ err, payout_id }, '[adi-payout-status] background confirmation failed');
        }
      });
    },
  );
};

export default adiPayoutRoute;
