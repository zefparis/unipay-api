import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { verifyToken } from '../../utils/jwt.js';

/* ── SSRF guard ─────────────────────────────────────────────── */
function isSafeWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname;
    const blocked = [
      /^localhost$/i, /^127\./, /^0\./, /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
      /^169\.254\./, /^::1$/, /^fc00:/i, /^fe80:/i,
    ];
    return !blocked.some((re) => re.test(host));
  } catch { return false; }
}

/* ── JWT helper ─────────────────────────────────────────────── */
function requireMerchant(auth: string | undefined, secret: string): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  const payload = verifyToken(auth.slice(7), secret);
  return payload?.merchant_id ?? null;
}

interface WebhookBody { webhook_url: string }

const merchantWebhookRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/merchant/webhook ─────────────────────────────── */
  fastify.get(
    '/merchant/webhook',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              configured:  { type: 'boolean' },
              webhook_url: { type: ['string', 'null'] },
              has_secret:  { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { data } = await fastify.supabase
        .from('merchants')
        .select('webhook_url, webhook_secret')
        .eq('id', merchantId)
        .maybeSingle();

      return reply.send({
        configured:  !!data?.webhook_url,
        webhook_url: data?.webhook_url ?? null,
        has_secret:  !!data?.webhook_secret,
      });
    },
  );

  /* ── POST /v1/merchant/webhook ────────────────────────────── */
  fastify.post<{ Body: WebhookBody }>(
    '/merchant/webhook',
    {
      schema: {
        body: {
          type: 'object',
          required: ['webhook_url'],
          properties: {
            webhook_url: { type: 'string', minLength: 8, maxLength: 512 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              webhook_url:    { type: 'string' },
              webhook_secret: { type: 'string' },
              note:           { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { webhook_url } = request.body;

      if (!isSafeWebhookUrl(webhook_url)) {
        return reply.status(400).send({
          error: 'Invalid webhook URL — must be HTTPS and not a private/loopback address',
          statusCode: 400,
        });
      }

      const webhookSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

      const { error } = await fastify.supabase
        .from('merchants')
        .update({ webhook_url, webhook_secret: webhookSecret })
        .eq('id', merchantId);

      if (error) {
        fastify.log.error({ err: error, merchantId }, 'Webhook save failed');
        return reply.status(500).send({ error: 'Failed to save webhook', statusCode: 500 });
      }

      fastify.log.info({ merchantId, webhook_url }, 'Webhook configured');

      return reply.send({
        webhook_url,
        webhook_secret: webhookSecret,
        note: 'Save this secret now — it will not be shown again.',
      });
    },
  );

  /* ── DELETE /v1/merchant/webhook ──────────────────────────── */
  fastify.delete(
    '/merchant/webhook',
    {
      schema: {
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      await fastify.supabase
        .from('merchants')
        .update({ webhook_url: null, webhook_secret: null })
        .eq('id', merchantId);

      fastify.log.info({ merchantId }, 'Webhook removed');
      return reply.send({ ok: true });
    },
  );

  /* ── POST /v1/merchant/webhook/test ──────────────────────── */
  fastify.post(
    '/merchant/webhook/test',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              ok:          { type: 'boolean' },
              status_code: { type: 'number' },
              duration_ms: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('webhook_url, webhook_secret')
        .eq('id', merchantId)
        .maybeSingle();

      if (!merchant?.webhook_url) {
        return reply.status(400).send({ error: 'No webhook URL configured', statusCode: 400 });
      }
      if (!isSafeWebhookUrl(merchant.webhook_url)) {
        return reply.status(400).send({ error: 'Webhook URL is not safe', statusCode: 400 });
      }

      const payload = JSON.stringify({
        event: 'webhook.test',
        timestamp: new Date().toISOString(),
        data: {
          transaction_id: `test_${crypto.randomBytes(4).toString('hex')}`,
          status: 'success',
          amount: 1000,
          fee: 40,
          net_amount: 960,
          currency: 'CDF',
          operator: 'orange',
          direction: 'collect',
        },
      });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (merchant.webhook_secret) {
        const sig = crypto
          .createHmac('sha256', merchant.webhook_secret)
          .update(payload)
          .digest('hex');
        headers['X-UniPay-Signature'] = `sha256=${sig}`;
      }

      const t0 = Date.now();
      try {
        const res = await fetch(merchant.webhook_url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
        return reply.send({ ok: res.ok, status_code: res.status, duration_ms: Date.now() - t0 });
      } catch (err: unknown) {
        fastify.log.warn({ err, merchantId }, 'Webhook test delivery failed');
        return reply.status(502).send({
          error: `Webhook delivery failed: ${(err as Error).message}`,
          statusCode: 502,
        });
      }
    },
  );
};

export default merchantWebhookRoute;
