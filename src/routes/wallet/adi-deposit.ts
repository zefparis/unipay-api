/**
 * POST /v1/adi/deposit-notify
 *
 * HMAC-signed webhook called by PredictStreet when a user's USDC deposit
 * on ADI Chain is confirmed on-chain.
 *
 * Flow:
 *  1. Verify HMAC-SHA256 signature (X-PredictStreet-Signature header)
 *  2. Idempotency check — return 200 early if payout_id already processed
 *  3. Fetch on-chain receipt via getAdiTransactionReceipt()
 *  4. Verify ERC-20 Transfer log via verifyAdiTransfer()
 *  5. Insert into adi_deposit_events + credit user CDF balance
 *  6. Return { ok: true, credited_cdf }
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { getAdiTransactionReceipt } from '../../lib/adi-withdrawal';
import { verifyAdiTransfer } from '../../lib/adi-verify';

/* ── Request body shape ─────────────────────────────────────────────────── */
interface AdiDepositNotifyBody {
  payout_id:   string;  // idempotency key
  user_id:     string;  // UniPay user reference
  tx_hash:     string;  // ADI Chain transaction hash
  amount_usdc: number;  // USDC amount (human-readable)
  amount_cdf:  number;  // pre-computed CDF credit amount
  timestamp:   number;  // Unix epoch seconds
}

/* ── HMAC verification ──────────────────────────────────────────────────── */
function verifyHmacSignature(
  rawBody:   string,
  signature: string,
  secret:    string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.toLowerCase()),
      Buffer.from(expected.toLowerCase()),
    );
  } catch {
    return false;
  }
}

/* ── Fastify plugin ─────────────────────────────────────────────────────── */
const adiDepositRoute: FastifyPluginAsync = async (fastify) => {
  if (!env.PREDICTSTREET_SERVER_SECRET) {
    fastify.log.warn('[adi-deposit] PREDICTSTREET_SERVER_SECRET not set — route disabled');
    return;
  }

  /* ────────────────────────────────────────────────────────────────────────
   * POST /v1/adi/deposit-notify
   * Auth: HMAC-SHA256 via X-PredictStreet-Signature header
   * ──────────────────────────────────────────────────────────────────────── */
  fastify.post<{ Body: AdiDepositNotifyBody }>(
    '/adi/deposit-notify',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['payout_id', 'user_id', 'tx_hash', 'amount_usdc', 'amount_cdf', 'timestamp'],
          properties: {
            payout_id:   { type: 'string', minLength: 1 },
            user_id:     { type: 'string', minLength: 1 },
            tx_hash:     { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
            amount_usdc: { type: 'number', minimum: 0.000001 },
            amount_cdf:  { type: 'number', minimum: 1 },
            timestamp:   { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const secret = env.PREDICTSTREET_SERVER_SECRET!;

      /* ── 1. HMAC signature verification ─────────────────────────────── */
      const signature = (request.headers['x-predictstreet-signature'] ?? '') as string;
      if (!signature) {
        return reply.status(401).send({ ok: false, error: 'missing_signature' });
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifyHmacSignature(rawBody, signature, secret)) {
        fastify.log.warn({ tx_hash: request.body?.tx_hash }, '[adi-deposit] HMAC verification failed');
        return reply.status(401).send({ ok: false, error: 'invalid_signature' });
      }

      const { payout_id, user_id, tx_hash, amount_usdc, amount_cdf } = request.body;

      /* ── 2. Idempotency check ────────────────────────────────────────── */
      const { data: existing } = await fastify.supabase
        .from('adi_deposit_events')
        .select('payout_id')
        .eq('payout_id', payout_id)
        .maybeSingle();

      if (existing) {
        fastify.log.info({ payout_id }, '[adi-deposit] already processed — returning 200');
        return reply.send({ ok: true, status: 'already_processed' });
      }

      /* ── 3. Fetch on-chain receipt ───────────────────────────────────── */
      const receipt = await getAdiTransactionReceipt(tx_hash);

      if (!receipt) {
        fastify.log.warn({ tx_hash }, '[adi-deposit] transaction not yet indexed on ADI Chain');
        return reply.status(422).send({ ok: false, error: 'tx_not_indexed' });
      }

      /* ── 4. Verify ERC-20 Transfer log ──────────────────────────────── */
      const verifyResult = verifyAdiTransfer(
        { logs: receipt.logs as any, status: receipt.status ?? 0 },
        'USDC',
        env.ADI_SETTLEMENT_ADDRESS,
        amount_usdc,
      );

      if (!verifyResult.verified) {
        fastify.log.warn(
          { tx_hash, payout_id, reasons: verifyResult.blocking_reasons, detail: verifyResult.reason },
          '[adi-deposit] on-chain verification failed',
        );
        return reply.status(422).send({
          ok:              false,
          error:           'verification_failed',
          blocking_reasons: verifyResult.blocking_reasons,
          detail:          verifyResult.reason,
        });
      }

      /* ── 5a. Insert deposit event (idempotency record) ─────────────── */
      const { error: insertErr } = await fastify.supabase
        .from('adi_deposit_events')
        .insert({
          payout_id,
          user_id,
          tx_hash,
          amount_usdc,
          amount_cdf,
          transferred_amount: verifyResult.transferred_amount,
          status:             'confirmed',
          created_at:         new Date().toISOString(),
        });

      if (insertErr) {
        fastify.log.error({ err: insertErr, payout_id }, '[adi-deposit] insert into adi_deposit_events failed');
        return reply.status(500).send({ ok: false, error: 'db_insert_failed' });
      }

      /* ── 5b. Credit user CDF balance ────────────────────────────────── */
      const { error: creditErr } = await fastify.supabase.rpc('credit_wallet_balance', {
        p_user_id:    user_id,
        p_amount_cdf: amount_cdf,
        p_source:     'adi_deposit',
        p_reference:  payout_id,
      });

      if (creditErr) {
        fastify.log.error({ err: creditErr, payout_id, user_id }, '[adi-deposit] credit_wallet_balance RPC failed');
        // Mark event as credit_failed so it can be retried by ops
        await fastify.supabase
          .from('adi_deposit_events')
          .update({ status: 'credit_failed' })
          .eq('payout_id', payout_id);
        return reply.status(500).send({ ok: false, error: 'credit_failed' });
      }

      fastify.log.info(
        { payout_id, user_id, tx_hash, amount_usdc, amount_cdf },
        '[adi-deposit] deposit confirmed and balance credited',
      );

      /* ── 6. Return success ──────────────────────────────────────────── */
      return reply.send({ ok: true, credited_cdf: amount_cdf });
    },
  );
};

export default adiDepositRoute;
