import crypto from 'node:crypto';
import Stripe from 'stripe';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

const MIN_USD = 5;

interface StripePaymentIntentObject {
  id:       string;
  amount:   number;
  metadata: Record<string, string>;
}

const walletStripeRoute: FastifyPluginAsync = async (fastify) => {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    fastify.log.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe routes disabled');
    return;
  }

  const stripe = new Stripe(stripeSecretKey);

  /* ─────────────────────────────────────────────────────────────
   * POST /v1/wallet/deposit/stripe/create-intent
   * Creates a Stripe PaymentIntent for a USD diaspora deposit.
   * Auth: wallet_token cookie (JWT)
   * Body: { amount_usd: number }  — minimum 5 USD
   * Returns: { client_secret, payment_intent_id }
   * ───────────────────────────────────────────────────────────── */
  fastify.post<{ Body: { amount_usd: number } }>(
    '/wallet/deposit/stripe/create-intent',
    {
      schema: {
        body: {
          type:       'object',
          required:   ['amount_usd'],
          properties: {
            amount_usd: { type: 'number', minimum: MIN_USD },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { amount_usd } = request.body;
      const amountCents = Math.round(amount_usd * 100);

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) return reply.status(404).send({ error: 'wallet_not_found' });

      const intent = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          wallet_user_id: wallet.id,
          phone:          wallet.phone,
        },
      });

      fastify.log.info(
        { walletId: wallet.id, amountUsd: amount_usd, intentId: intent.id },
        '[stripe] payment intent created',
      );

      return reply.status(201).send({
        client_secret:     intent.client_secret,
        payment_intent_id: intent.id,
      });
    },
  );

  /* ─────────────────────────────────────────────────────────────
   * POST /v1/wallet/deposit/stripe/webhook
   * Stripe event webhook — public, signature-verified.
   * On payment_intent.succeeded → credit usd_balance (idempotent).
   * Configure in Stripe Dashboard:
   *   URL: https://unipay-api.onrender.com/v1/wallet/deposit/stripe/webhook
   *   Events: payment_intent.succeeded
   * ───────────────────────────────────────────────────────────── */
  fastify.register(async (sub) => {
    // Raw body required for Stripe signature verification
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    sub.post('/wallet/deposit/stripe/webhook', async (request, reply) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        fastify.log.error('[stripe] STRIPE_WEBHOOK_SECRET not configured');
        return reply.status(500).send({ error: 'misconfigured' });
      }

      const sig = request.headers['stripe-signature'] as string;
      let event: ReturnType<typeof stripe.webhooks.constructEvent>;
      try {
        event = stripe.webhooks.constructEvent(request.body as Buffer, sig, webhookSecret);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.warn({ msg }, '[stripe] webhook signature verification failed');
        return reply.status(400).send({ error: 'invalid_signature' });
      }

      if (event.type !== 'payment_intent.succeeded') {
        return reply.status(200).send({ received: true });
      }

      const intent      = event.data.object as StripePaymentIntentObject;
      const walletUserId = intent.metadata?.wallet_user_id;
      const amountUsd    = intent.amount / 100;

      if (!walletUserId) {
        fastify.log.warn({ intentId: intent.id }, '[stripe] missing wallet_user_id in metadata');
        return reply.status(200).send({ received: true });
      }

      // Idempotence — skip if already processed
      const { data: existing } = await fastify.supabase
        .from('transactions')
        .select('id')
        .eq('reference', intent.id)
        .maybeSingle();

      if (existing) {
        return reply.status(200).send({ received: true, already_processed: true });
      }

      // Credit usd_balance via atomic RPC
      const { error: rpcError } = await fastify.supabase
        .rpc('wallet_credit_usd', { p_user_id: walletUserId, p_amount: amountUsd });

      if (rpcError) {
        fastify.log.error({ rpcError, walletUserId, amountUsd }, '[stripe] wallet_credit_usd RPC failed');
        return reply.status(500).send({ error: 'credit_failed' });
      }

      // Record transaction
      const txId = crypto.randomUUID();
      await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: walletUserId,
        operator:       'stripe',
        direction:      'deposit',
        amount:         amountUsd,
        fee:            0,
        net_amount:     amountUsd,
        currency:       'USD',
        reference:      intent.id,
        status:         'success',
        metadata:       { stripe_payment_intent: intent.id, source: 'stripe_webhook' },
      });

      fastify.log.info(
        { walletUserId, amountUsd, intentId: intent.id },
        '[stripe] deposit credited',
      );

      return reply.status(200).send({ received: true });
    });
  });
};

export default walletStripeRoute;
