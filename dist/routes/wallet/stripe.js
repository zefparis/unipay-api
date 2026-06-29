"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const stripe_1 = __importDefault(require("stripe"));
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const MIN_USD = 5;
const walletStripeRoute = async (fastify) => {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
        fastify.log.warn('[stripe] STRIPE_SECRET_KEY not set — Stripe routes disabled');
        return;
    }
    const stripe = new stripe_1.default(stripeSecretKey);
    /* ─────────────────────────────────────────────────────────────
     * POST /v1/wallet/deposit/stripe/create-intent
     * Creates a Stripe PaymentIntent for a USD diaspora deposit.
     * Auth: wallet_token cookie (JWT)
     * Body: { amount_usd: number }  — minimum 5 USD
     * Returns: { client_secret, payment_intent_id }
     * ───────────────────────────────────────────────────────────── */
    fastify.post('/wallet/deposit/stripe/create-intent', {
        schema: {
            body: {
                type: 'object',
                required: ['amount_usd'],
                properties: {
                    amount_usd: { type: 'number', minimum: MIN_USD },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const payload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!payload)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { amount_usd } = request.body;
        const amountCents = Math.round(amount_usd * 100);
        const { data: wallet } = await fastify.supabase
            .from('wallet_users')
            .select('id, phone')
            .eq('id', payload.wallet_id)
            .maybeSingle();
        if (!wallet)
            return reply.status(404).send({ error: 'wallet_not_found' });
        const intent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            metadata: {
                wallet_user_id: wallet.id,
                phone: wallet.phone,
            },
        });
        fastify.log.info({ walletId: wallet.id, amountUsd: amount_usd, intentId: intent.id }, '[stripe] payment intent created');
        return reply.status(201).send({
            client_secret: intent.client_secret,
            payment_intent_id: intent.id,
        });
    });
    /* ─────────────────────────────────────────────────────────────
     * POST /v1/wallet/deposit/stripe/create-checkout
     * Creates a Stripe Checkout Session (hosted payment page).
     * No Stripe.js needed on the frontend — just redirect to session.url.
     * Auth: wallet_token (JWT)
     * Body: { amount_usd, success_url, cancel_url }
     * Returns: { url }
     * ───────────────────────────────────────────────────────────── */
    fastify.post('/wallet/deposit/stripe/create-checkout', {
        schema: {
            body: {
                type: 'object',
                required: ['amount_usd', 'success_url', 'cancel_url'],
                properties: {
                    amount_usd: { type: 'number', minimum: MIN_USD },
                    success_url: { type: 'string' },
                    cancel_url: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const payload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!payload)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { amount_usd, success_url, cancel_url } = request.body;
        const { data: wallet } = await fastify.supabase
            .from('wallet_users')
            .select('id, phone')
            .eq('id', payload.wallet_id)
            .maybeSingle();
        if (!wallet)
            return reply.status(404).send({ error: 'wallet_not_found' });
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                    price_data: {
                        currency: 'usd',
                        unit_amount: Math.round(amount_usd * 100),
                        product_data: {
                            name: 'Dépôt UnipayCongo',
                            description: `Dépôt de ${amount_usd.toFixed(2)} USD sur votre portefeuille`,
                        },
                    },
                    quantity: 1,
                }],
            payment_intent_data: {
                metadata: { wallet_user_id: wallet.id, phone: wallet.phone ?? '' },
            },
            metadata: { wallet_user_id: wallet.id, phone: wallet.phone ?? '' },
            success_url,
            cancel_url,
        });
        fastify.log.info({ walletId: wallet.id, amountUsd: amount_usd, sessionId: session.id }, '[stripe] checkout session created');
        return reply.status(201).send({ url: session.url });
    });
    /* ─────────────────────────────────────────────────────────────
     * POST /v1/wallet/deposit/stripe/webhook
     * Stripe event webhook — public, signature-verified.
     * On payment_intent.succeeded → credit usd_balance (idempotent).
     * Configure in Stripe Dashboard:
     *   URL: https://unipay-api.onrender.com/v1/wallet/deposit/stripe/webhook
     *   Events: payment_intent.succeeded
     * ───────────────────────────────────────────────────────────── */
    fastify.register(async (sub) => {
        // Fastify v4 inherits the parent JSON parser — remove it before registering the buffer parser
        sub.removeContentTypeParser('application/json');
        sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
            done(null, body);
        });
        sub.post('/wallet/deposit/stripe/webhook', async (request, reply) => {
            const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
            if (!webhookSecret) {
                fastify.log.error('[stripe] STRIPE_WEBHOOK_SECRET not configured');
                return reply.status(500).send({ error: 'misconfigured' });
            }
            const sig = request.headers['stripe-signature'];
            let event;
            try {
                event = stripe.webhooks.constructEvent(request.body, sig, webhookSecret);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                fastify.log.warn({ msg }, '[stripe] webhook signature verification failed');
                return reply.status(400).send({ error: 'invalid_signature' });
            }
            if (event.type !== 'payment_intent.succeeded') {
                return reply.status(200).send({ received: true });
            }
            const intent = event.data.object;
            const walletUserId = intent.metadata?.wallet_user_id;
            const amountUsd = intent.amount / 100;
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
            const txId = node_crypto_1.default.randomUUID();
            await fastify.supabase.from('transactions').insert({
                id: txId,
                wallet_user_id: walletUserId,
                operator: 'stripe',
                direction: 'deposit',
                amount: amountUsd,
                fee: 0,
                net_amount: amountUsd,
                currency: 'USD',
                reference: intent.id,
                status: 'success',
                metadata: { stripe_payment_intent: intent.id, source: 'stripe_webhook' },
            });
            fastify.log.info({ walletUserId, amountUsd, intentId: intent.id }, '[stripe] deposit credited');
            return reply.status(200).send({ received: true });
        });
    });
};
exports.default = walletStripeRoute;
//# sourceMappingURL=stripe.js.map