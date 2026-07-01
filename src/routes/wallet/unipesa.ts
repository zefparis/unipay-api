/**
 * /v1/wallet/unipesa — USD deposit, withdrawal, and callback webhook.
 *
 * Routes:
 *   POST /wallet/unipesa/deposit   – C2B: collect USD from subscriber's mobile money
 *   POST /wallet/unipesa/withdraw  – B2C: pay USD to subscriber's mobile money
 *   POST /wallet/unipesa/callback  – Unipesa webhook (public, signature-verified)
 *
 * Callback logic:
 *   currency === 'USD' → credit usd_balance  (via wallet_credit_usd RPC)
 *   currency === 'CDF' → credit balance_cdf  (via direct update)
 */
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import {
  depositUSD,
  withdrawUSD,
  verifyCallbackSignature,
  newOrderId,
  UNIPESA_USD_PROVIDER_IDS,
} from '../../lib/unipesa';
import { sendWalletDepositEmail } from '../../services/email';

const FEE_RATE       = 0.03;
const USD_OPERATORS  = ['orange', 'airtel', 'africell'] as const;
const MIN_USD_AMOUNT = 1;

const walletUnipesaRoute: FastifyPluginAsync = async (fastify) => {

  /* ─────────────────────────────────────────────────────────────
   * POST /v1/wallet/unipesa/deposit
   * Initiates a USD Mobile Money → UniPay collection (C2B).
   * Body: { phone_mm, operator, amount_usd }
   * ───────────────────────────────────────────────────────────── */
  fastify.post<{ Body: { phone: string; operator: string; amount: number } }>(
    '/wallet/unipesa/deposit',
    {
      schema: {
        body: {
          type:       'object',
          required:   ['phone', 'operator', 'amount'],
          properties: {
            phone:    { type: 'string' },
            operator: { type: 'string', enum: [...USD_OPERATORS] },
            amount:   { type: 'number', minimum: MIN_USD_AMOUNT },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured' });
      const authPayload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!authPayload) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { phone, operator, amount: amount_usd } = request.body;
      const walletId        = authPayload.wallet_id;
      const normalizedPhone = phone.replace(/\s/g, '');

      if (!/^\+243[0-9]{9}$/.test(normalizedPhone)) {
        return reply.status(400).send({
          error:   'INVALID_PHONE',
          message: 'Required format: +243XXXXXXXXX',
        });
      }

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, is_active, kyc_level')
        .eq('id', walletId)
        .maybeSingle();

      if (!wallet?.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const fee        = Math.round(amount_usd * FEE_RATE * 100) / 100;
      const netAmount  = Math.round((amount_usd - fee) * 100) / 100;
      const txId       = crypto.randomUUID();
      const orderId    = newOrderId();
      const providerId = UNIPESA_USD_PROVIDER_IDS[operator];

      if (providerId === undefined) {
        fastify.log.error({ operator }, '[unipesa/deposit] unknown USD operator — no provider_id mapped');
        return reply.status(400).send({ error: 'Unsupported USD operator', statusCode: 400 });
      }

      const { error: insertErr } = await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: walletId,
        operator,
        direction:      'collect',
        amount:         amount_usd,
        fee,
        net_amount:     netAmount,
        currency:       'USD',
        phone:          normalizedPhone,
        reference:      orderId,
        status:         'pending',
        metadata:       { source: 'unipesa_usd_deposit' },
      });

      if (insertErr) {
        fastify.log.error({ err: insertErr, txId }, '[unipesa/deposit] insert failed');
        return reply.status(500).send({ error: 'Failed to create deposit', statusCode: 500 });
      }

      try {
        fastify.log.info(
          { txId, walletId, operator, providerId, currency: 'USD', amount_usd, orderId, phone: normalizedPhone },
          '[unipesa/deposit] calling Unipesa C2B',
        );

        const unipesaResp = await depositUSD({
          order_id:    orderId,
          customer_id: normalizedPhone,
          amount:      amount_usd,
          provider_id: providerId,
        });

        fastify.log.info({ txId, unipesaResp }, '[unipesa/deposit] Unipesa response');

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing' })
          .eq('id', txId);

        fastify.log.info({ txId, walletId, operator, amount_usd }, '[unipesa/deposit] initiated');

        return reply.status(201).send({
          transaction_id: txId,
          status:         'processing',
          amount:         amount_usd,
          fee,
          net_amount:     netAmount,
          currency:       'USD',
        });
      } catch (err: any) {
        fastify.log.error(
          { err: err?.message, errResponse: (err as any)?.response, txId, operator },
          '[unipesa/deposit] provider call failed',
        );
        await fastify.supabase.from('transactions').update({ status: 'failed' }).eq('id', txId);
        return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
      }
    },
  );

  /* ─────────────────────────────────────────────────────────────
   * POST /v1/wallet/unipesa/withdraw
   * Initiates a UniPay → Mobile Money payout (B2C) in USD.
   * Atomically debits usd_balance before calling Unipesa.
   * Refunds on provider failure.
   * Body: { phone_mm, operator, amount_usd }
   * ───────────────────────────────────────────────────────────── */
  fastify.post<{ Body: { phone: string; operator: string; amount: number } }>(
    '/wallet/unipesa/withdraw',
    {
      schema: {
        body: {
          type:       'object',
          required:   ['phone', 'operator', 'amount'],
          properties: {
            phone:    { type: 'string' },
            operator: { type: 'string', enum: [...USD_OPERATORS] },
            amount:   { type: 'number', minimum: MIN_USD_AMOUNT },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured' });
      const authPayload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!authPayload) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { phone, operator, amount: amount_usd } = request.body;
      const walletId        = authPayload.wallet_id;
      const normalizedPhone = phone.replace(/\s/g, '');

      if (!/^\+243[0-9]{9}$/.test(normalizedPhone)) {
        return reply.status(400).send({
          error:   'INVALID_PHONE',
          message: 'Required format: +243XXXXXXXXX',
        });
      }

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, is_active, usd_balance')
        .eq('id', walletId)
        .maybeSingle();

      if (!wallet?.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const usdBalance = Number(wallet.usd_balance ?? 0);
      const fee        = Math.round(amount_usd * FEE_RATE * 100) / 100;
      const totalCost  = Math.round((amount_usd + fee) * 100) / 100;

      if (usdBalance < totalCost) {
        return reply.status(402).send({
          error:       'Insufficient USD balance',
          usd_balance: usdBalance,
          required:    totalCost,
          statusCode:  402,
        });
      }

      // Atomic debit — raises INSUFFICIENT_FUNDS if race-condition
      const { error: debitErr } = await fastify.supabase
        .rpc('wallet_debit_usd', { p_user_id: walletId, p_amount: totalCost });

      if (debitErr) {
        const isInsufficient = debitErr.message?.includes('INSUFFICIENT_FUNDS');
        return reply.status(isInsufficient ? 402 : 500).send({
          error:      isInsufficient ? 'Insufficient USD balance' : 'Debit failed',
          statusCode: isInsufficient ? 402 : 500,
        });
      }

      const txId       = crypto.randomUUID();
      const orderId    = newOrderId();
      const providerId = UNIPESA_USD_PROVIDER_IDS[operator];

      if (providerId === undefined) {
        fastify.log.error({ operator }, '[unipesa/withdraw] unknown USD operator — no provider_id mapped');
        await fastify.supabase.rpc('wallet_credit_usd', { p_user_id: walletId, p_amount: totalCost });
        return reply.status(400).send({ error: 'Unsupported USD operator', statusCode: 400 });
      }

      await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: walletId,
        operator,
        direction:      'payout',
        amount:         amount_usd,
        fee,
        net_amount:     amount_usd,
        currency:       'USD',
        phone:          normalizedPhone,
        reference:      orderId,
        status:         'pending',
        metadata:       { source: 'unipesa_usd_withdraw' },
      });

      try {
        fastify.log.info(
          { txId, walletId, operator, providerId, currency: 'USD', amount_usd, totalCost, fee, orderId, phone: normalizedPhone },
          '[unipesa/withdraw] calling Unipesa B2C',
        );

        const unipesaResp = await withdrawUSD({
          order_id:    orderId,
          customer_id: normalizedPhone,
          amount:      amount_usd,
          provider_id: providerId,
        });

        fastify.log.info({ txId, unipesaResp }, '[unipesa/withdraw] Unipesa response');

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing' })
          .eq('id', txId);

        fastify.log.info({ txId, walletId, operator, amount_usd }, '[unipesa/withdraw] initiated');

        return reply.status(201).send({
          transaction_id: txId,
          status:         'processing',
          amount:         amount_usd,
          fee,
          net_amount:     amount_usd,
          currency:       'USD',
        });
      } catch (err: any) {
        // Refund: atomically credit back the deducted amount
        fastify.log.error(
          { err: err?.message, errResponse: (err as any)?.response, txId, walletId },
          '[unipesa/withdraw] provider failed — refunding',
        );
        await fastify.supabase.rpc('wallet_credit_usd', { p_user_id: walletId, p_amount: totalCost });
        await fastify.supabase.from('transactions')
          .update({ status: 'failed' })
          .eq('id', txId);
        return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
      }
    },
  );

  /* ─────────────────────────────────────────────────────────────
   * POST /v1/wallet/unipesa/callback   (public — no JWT)
   *
   * Unipesa sends this after a C2B or B2C completes.
   * We verify the HMAC signature, then:
   *   status=1 + direction=collect + currency=USD  → credit usd_balance
   *   status=1 + direction=collect + currency=CDF  → credit balance_cdf
   *   status=1 + direction=payout                  → mark tx success (already debited)
   *   status≠1                                     → mark tx failed
   *
   * Idempotent: already-successful transactions are silently ignored.
   * ───────────────────────────────────────────────────────────── */
  fastify.post('/wallet/unipesa/callback', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, any>;

    if (!verifyCallbackSignature(body)) {
      fastify.log.warn({ body }, '[unipesa/callback] invalid signature');
      return reply.status(400).send({ error: 'Invalid signature' });
    }

    const { order_id, status, currency, amount } = body;
    if (!order_id) return reply.status(400).send({ error: 'Missing order_id' });

    fastify.log.info({ order_id, status, currency, amount }, '[unipesa/callback] received');

    // Unipesa status=2 → success (confirmed)
    if (Number(status) !== 2) {
      await fastify.supabase
        .from('transactions')
        .update({ status: 'failed', metadata: { unipesa_status: status } })
        .eq('reference', order_id)
        .in('status', ['pending', 'processing']);
      return reply.status(200).send({ received: true, credited: false });
    }

    // Find the pending/processing transaction by reference (= orderId we sent)
    const { data: tx } = await fastify.supabase
      .from('transactions')
      .select('id, wallet_user_id, net_amount, currency, direction, status')
      .eq('reference', order_id)
      .maybeSingle();

    if (!tx) {
      fastify.log.warn({ order_id }, '[unipesa/callback] tx not found');
      return reply.status(404).send({ error: 'Transaction not found' });
    }

    // Idempotency guard
    if (tx.status === 'success') {
      return reply.status(200).send({ received: true, already_credited: true });
    }

    // For payouts (B2C), balance was already debited at initiation — just confirm.
    if (tx.direction === 'payout') {
      await fastify.supabase
        .from('transactions')
        .update({ status: 'success' })
        .eq('id', tx.id);
      return reply.status(200).send({ received: true, credited: false });
    }

    // For collections (C2B), credit the correct balance.
    const netCredited = Number(tx.net_amount ?? amount);
    const txCurrency  = String(tx.currency ?? currency).toUpperCase();

    if (txCurrency === 'USD') {
      const { error: creditErr } = await fastify.supabase
        .rpc('wallet_credit_usd', { p_user_id: tx.wallet_user_id, p_amount: netCredited });
      if (creditErr) {
        fastify.log.error({ err: creditErr.message, txId: tx.id }, '[unipesa/callback] USD credit failed');
        return reply.status(500).send({ error: 'Credit failed' });
      }
    } else {
      // CDF — plain update (read-modify-write acceptable for rare callback path)
      const { data: w } = await fastify.supabase
        .from('wallet_users')
        .select('balance_cdf')
        .eq('id', tx.wallet_user_id)
        .single();
      const newCdf = Number(w?.balance_cdf ?? 0) + netCredited;
      await fastify.supabase
        .from('wallet_users')
        .update({ balance_cdf: newCdf })
        .eq('id', tx.wallet_user_id);
    }

    await fastify.supabase
      .from('transactions')
      .update({ status: 'success' })
      .eq('id', tx.id);

    fastify.log.info(
      { txId: tx.id, walletId: tx.wallet_user_id, txCurrency, netCredited },
      '[unipesa/callback] credited',
    );

    // Fire-and-forget deposit confirmation email
    const { data: uUser } = await fastify.supabase
      .from('wallet_users')
      .select('email, full_name, lang')
      .eq('id', tx.wallet_user_id)
      .maybeSingle();
    if (uUser?.email) {
      sendWalletDepositEmail({
        to: uUser.email, name: uUser.full_name ?? '',
        amount: netCredited.toFixed(txCurrency === 'USD' ? 2 : 0), currency: txCurrency,
        method: 'Mobile Money (USD)', txRef: order_id,
        lang: uUser.lang ?? 'fr',
      });
    }

    // Notify PredictStreet if this is a PredictStreet deposit
    if (order_id?.startsWith('ps-dep-')) {
      const psSecret = env.HMAC_SECRET;
      const psUrl = env.PREDICTSTREET_PAYOUT_URL;
      if (psSecret && psUrl) {
        const psPayload = JSON.stringify({
          payout_id: order_id,
          status: 'completed',
          operator_ref: order_id,
        });
        const psSig = crypto.createHmac('sha256', psSecret).update(psPayload).digest('hex');
        fetch(psUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-UniPay-Signature': `sha256=${psSig}`,
          },
          body: psPayload,
        }).catch((err: unknown) => {
          fastify.log.warn({ err, order_id }, '[predictstreet] completion webhook delivery failed');
        });
        fastify.log.info({ order_id }, '[predictstreet] completion webhook sent');
      }
    }

    return reply.status(200).send({ received: true, credited: true, currency: txCurrency, amount: netCredited });
  });
};

export default walletUnipesaRoute;
