/**
 * POST /v1/adi/deposit-notify
 *
 * Webhook called by PredictStreet when a USDC deposit on ADI Chain is confirmed.
 *
 * PredictStreet payload:
 *   { tx_hash, log_index, amount (6-decimal USDC), from (sender address) }
 * Header: x-predictstreet-signature: sha256=<hex>
 *
 * Flow:
 *  1. (TEMP) Skip HMAC — TODO re-enable before go-live
 *  2. Idempotency check on tx_hash + log_index
 *  3. Convert amount (6 decimals) to USDC float and CDF
 *  4. Insert into adi_deposit_events (no user credit for now — from address lookup TBD)
 *  5. Return { ok: true, tx_hash, amount_usdc }
 */

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
// import { getAdiTransactionReceipt } from '../../lib/adi-withdrawal'; // reserved for on-chain re-verification
// import { verifyAdiTransfer } from '../../lib/adi-verify';             // reserved for on-chain re-verification

/* ── Request body shape (PredictStreet actual format) ──────────────────── */
interface AdiDepositNotifyBody {
  tx_hash:   string;  // ADI Chain transaction hash (0x...)
  log_index: number;  // ERC-20 Transfer log index (for uniqueness)
  amount:    number;  // USDC amount in 6-decimal units (e.g. 1000000 = 1 USDC)
  from:      string;  // Sender wallet address
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
   * Auth: HMAC-SHA256 via x-predictstreet-signature (TEMP disabled for test)
   * ──────────────────────────────────────────────────────────────────────── */
  fastify.post<{ Body: AdiDepositNotifyBody }>(
    '/adi/deposit-notify',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['tx_hash', 'amount', 'from'],
          properties: {
            tx_hash:   { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
            log_index: { type: 'number' },
            amount:    { type: 'number', minimum: 0 },
            from:      { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { tx_hash, log_index = 0, amount, from } = request.body;

      /* ── 1. TEMP: skip HMAC verification ────────────────────────────── */
      // TODO: re-enable before go-live
      // const rawSig = (request.headers['x-predictstreet-signature'] ?? '') as string;
      // const signature = rawSig.startsWith('sha256=') ? rawSig.slice(7) : rawSig;
      // const rawBody = JSON.stringify(request.body);
      // if (!verifyHmacSignature(rawBody, signature, env.PREDICTSTREET_SERVER_SECRET!)) {
      //   return reply.status(401).send({ ok: false, error: 'invalid_signature' });
      // }

      /* ── 2. Idempotency check (tx_hash + log_index) ─────────────────── */
      const payout_id = `${tx_hash}_${log_index}`;

      const { data: existing } = await fastify.supabase
        .from('adi_deposit_events')
        .select('payout_id')
        .eq('payout_id', payout_id)
        .maybeSingle();

      if (existing) {
        fastify.log.info({ payout_id }, '[adi-deposit] already processed — returning 200');
        return reply.send({ ok: true, status: 'already_processed' });
      }

      /* ── 3. Convert amounts ─────────────────────────────────────────── */
      const amount_usdc = amount / 1_000_000;          // 6-decimal → float
      const amount_cdf  = amount_usdc * 2600;           // our CDF rate

      /* ── 4. Insert deposit event ────────────────────────────────────── */
      const { error: insertErr } = await fastify.supabase
        .from('adi_deposit_events')
        .insert({
          payout_id,
          tx_hash,
          amount_usdc,
          amount_cdf,
          from_address: from,
          status:       'confirmed',
          created_at:   new Date().toISOString(),
        });

      if (insertErr) {
        fastify.log.error({ err: insertErr, payout_id }, '[adi-deposit] insert into adi_deposit_events failed');
        return reply.status(500).send({ ok: false, error: 'db_insert_failed' });
      }

      fastify.log.info(
        { payout_id, tx_hash, from, amount_usdc, amount_cdf },
        '[adi-deposit] deposit event stored (user credit TBD — from address lookup)',
      );

      /* ── 5. Return success ──────────────────────────────────────────── */
      return reply.send({ ok: true, tx_hash, amount_usdc });
    },
  );
};

export default adiDepositRoute;
