import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

const MIN_FIAT  = 10;  // USD/EUR minimum
const SPREAD    = 0.985; // 1.5% UniPay spread applied on the CDF rate
const RATE_TTL  = 60_000; // 60 s in-memory cache for CoinGecko rate

const TRANSAK_URLS: Record<string, string> = {
  STAGING:    'https://global-stg.transak.com',
  PRODUCTION: 'https://global.transak.com',
};

/* ── CoinGecko in-memory rate cache ─────────────────────────────────────── */
const rateCache = { rate: 0, ts: 0 };

async function fetchUsdtCdfRate(fallback: number): Promise<number> {
  if (rateCache.rate > 0 && Date.now() - rateCache.ts < RATE_TTL) return rateCache.rate;
  try {
    const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cdf');
    const data = await res.json() as { tether?: { cdf?: number } };
    const raw  = data?.tether?.cdf;
    if (!raw || raw <= 0) throw new Error('bad rate');
    rateCache.rate = raw * SPREAD;
    rateCache.ts   = Date.now();
    return rateCache.rate;
  } catch {
    return fallback;
  }
}

/* ── Transak event shape (partial) ─────────────────────────────────────── */
interface TransakEventData {
  id?:              string;
  partnerOrderId?:  string;
  status?:          string;
  cryptoAmount?:    number;
  [k: string]:      unknown;
}

/* ── Fastify plugin ─────────────────────────────────────────────────────── */
const walletTransakRoute: FastifyPluginAsync = async (fastify) => {
  const apiKey = process.env.TRANSAK_API_KEY;
  if (!apiKey) {
    fastify.log.warn('[transak] TRANSAK_API_KEY not set — routes disabled');
    return;
  }

  const transakEnv = (process.env.TRANSAK_ENVIRONMENT ?? 'STAGING').toUpperCase();
  const baseUrl    = TRANSAK_URLS[transakEnv] ?? TRANSAK_URLS.STAGING;
  const appUrl     = process.env.APP_URL ?? 'https://app.unipaycongo.com';

  /* ─────────────────────────────────────────────────────────────────────────
   * GET /v1/rates/usdt-cdf  — public, 60 s cache
   * ───────────────────────────────────────────────────────────────────────── */
  fastify.get('/rates/usdt-cdf', async (_req, reply) => {
    const fallback = Number(env.FIAT_USD_CDF_RATE ?? '2850');
    const rate     = await fetchUsdtCdfRate(fallback);
    return reply
      .header('Cache-Control', 'public, max-age=60')
      .send({ rate, updated_at: new Date(rateCache.ts || Date.now()).toISOString() });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * POST /v1/wallet/transak/init
   * Auth: wallet_token JWT
   * Body: { amount_fiat, currency, wallet_address?, redirect_url? }
   * Returns: { transakUrl, orderId }
   * ───────────────────────────────────────────────────────────────────────── */
  fastify.post<{
    Body: { amount_fiat: number; currency: string; wallet_address?: string; redirect_url?: string };
  }>(
    '/wallet/transak/init',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type:       'object',
          required:   ['amount_fiat', 'currency'],
          properties: {
            amount_fiat:    { type: 'number', minimum: MIN_FIAT },
            currency:       { type: 'string', enum: ['USD', 'EUR'] },
            wallet_address: { type: 'string' },
            redirect_url:   { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'auth_not_configured' });
      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { amount_fiat, currency, wallet_address, redirect_url } = request.body;

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) return reply.status(404).send({ error: 'wallet_not_found' });

      // Use custody wallet if caller did not supply a BSC address
      const destination = wallet_address?.trim() || (process.env.USDT_WALLET_ADDRESS ?? '');
      const isCustody   = !wallet_address?.trim();

      if (!destination) {
        return reply.status(400).send({
          error:   'wallet_address_required',
          message: 'Provide a BSC wallet address or configure USDT_WALLET_ADDRESS on the server.',
        });
      }

      const orderId = crypto.randomUUID();

      const { error: dbErr } = await fastify.supabase
        .from('transak_orders')
        .insert({
          id:            orderId,
          user_id:       payload.wallet_id,
          status:        'PENDING',
          fiat_amount:   amount_fiat,
          fiat_currency: currency,
          wallet_address: destination,
          is_custody:    isCustody,
        });

      if (dbErr) {
        fastify.log.error({ err: dbErr }, '[transak] order insert failed');
        return reply.status(500).send({ error: 'order_create_failed' });
      }

      // Construct Transak hosted widget URL (no SDK needed — just query params)
      const successRedirect =
        redirect_url ?? `${appUrl}/wallet/deposit?transak_done=${orderId}`;

      const params = new URLSearchParams({
        apiKey,
        environment:               transakEnv,
        cryptoCurrencyCode:        'USDT',
        network:                   'bsc',
        defaultNetwork:            'bsc',
        walletAddress:             destination,
        fiatAmount:                String(amount_fiat),
        fiatCurrency:              currency,
        disableWalletAddressForm:  'true',
        hideMenu:                  'true',
        themeColor:                '1a56db',
        partnerOrderId:            orderId,
        redirectURL:               successRedirect,
      });

      const transakUrl = `${baseUrl}/?${params.toString()}`;

      fastify.log.info(
        { orderId, walletId: wallet.id, amount_fiat, currency, isCustody },
        '[transak] order created',
      );

      return reply.status(201).send({ transakUrl, orderId });
    },
  );

  /* ─────────────────────────────────────────────────────────────────────────
   * POST /v1/wallet/transak/webhook  — public, HMAC-SHA256 verified
   * Events: ORDER_CREATED | ORDER_PAYMENT_VERIFYING | ORDER_COMPLETED
   *         ORDER_FAILED | ORDER_CANCELLED
   * On ORDER_COMPLETED + is_custody=true → credit usd_balance (idempotent)
   * ───────────────────────────────────────────────────────────────────────── */
  fastify.register(async (sub) => {
    sub.removeContentTypeParser('application/json');
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    sub.post('/wallet/transak/webhook', async (request, reply) => {
      const secret = process.env.TRANSAK_SECRET;
      if (!secret) {
        fastify.log.error('[transak] TRANSAK_SECRET not set');
        return reply.status(500).send({ error: 'misconfigured' });
      }

      const rawBody = request.body as Buffer;
      const sig     = request.headers['x-transak-signature'] as string | undefined;
      if (!sig) return reply.status(400).send({ error: 'missing_signature' });

      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf   = Buffer.from(sig.padEnd(expected.length));
      const expBuf   = Buffer.from(expected.padEnd(sig.length));
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        fastify.log.warn('[transak] webhook signature mismatch');
        return reply.status(403).send({ error: 'invalid_signature' });
      }

      let parsed: { eventID?: string; eventData?: TransakEventData };
      try { parsed = JSON.parse(rawBody.toString()); } catch {
        return reply.status(400).send({ error: 'invalid_json' });
      }

      const { eventID, eventData } = parsed;
      if (!eventData) return reply.status(200).send({ ok: true });

      const partnerOrderId = eventData.partnerOrderId;
      const newStatus      = eventData.status ?? 'UNKNOWN';

      fastify.log.info(
        { eventID, partnerOrderId, status: newStatus },
        '[transak] webhook event',
      );

      // Fetch our order (guard against unknown partnerOrderId)
      const { data: order } = await fastify.supabase
        .from('transak_orders')
        .select('id, user_id, status, is_custody')
        .eq('id', partnerOrderId)
        .maybeSingle();

      if (!order) {
        fastify.log.warn({ partnerOrderId }, '[transak] unknown order in webhook');
        return reply.status(200).send({ ok: true }); // always 200 to Transak
      }

      // Update order record
      await fastify.supabase
        .from('transak_orders')
        .update({
          status:          newStatus,
          transak_order_id: eventData.id ?? null,
          crypto_amount:   eventData.cryptoAmount ?? null,
          updated_at:      new Date().toISOString(),
        })
        .eq('id', order.id);

      // Credit usd_balance — only once, only for custody wallet orders
      if (
        newStatus === 'COMPLETED' &&
        order.is_custody &&
        order.status !== 'COMPLETED'
      ) {
        const cryptoAmt = Number(eventData.cryptoAmount ?? 0);
        if (cryptoAmt > 0) {
          const { error: creditErr } = await fastify.supabase.rpc('wallet_credit_usd', {
            p_user_id: order.user_id,
            p_amount:  cryptoAmt,
          });
          if (creditErr) {
            fastify.log.error(
              { err: creditErr, userId: order.user_id, cryptoAmt },
              '[transak] wallet_credit_usd failed',
            );
          } else {
            fastify.log.info(
              { userId: order.user_id, cryptoAmt },
              '[transak] usd_balance credited',
            );
          }
        }
      }

      return reply.status(200).send({ ok: true });
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * GET /v1/wallet/transak/orders/:orderId
   * Auth: wallet_token JWT — user can only read their own orders
   * ───────────────────────────────────────────────────────────────────────── */
  fastify.get<{ Params: { orderId: string } }>(
    '/wallet/transak/orders/:orderId',
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'auth_not_configured' });
      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { data: order } = await fastify.supabase
        .from('transak_orders')
        .select('id, status, fiat_amount, fiat_currency, crypto_amount, wallet_address, is_custody, created_at, updated_at')
        .eq('id', request.params.orderId)
        .eq('user_id', payload.wallet_id) // ownership check
        .maybeSingle();

      if (!order) return reply.status(404).send({ error: 'order_not_found' });
      return reply.send(order);
    },
  );
};

export default walletTransakRoute;
