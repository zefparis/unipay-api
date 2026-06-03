import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';

interface CallbackBody {
  provider_ref: string;
  status: 'success' | 'failed';
  channel?: string;
  raw_payload?: Record<string, unknown>;
}

// SSRF guard: only HTTPS to non-private/loopback hosts
function isSafeWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname;
    // Block loopback, link-local, private ranges, metadata endpoints
    const blocked = [
      /^localhost$/i,
      /^127\./,
      /^0\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/i,
      /^fe80:/i,
    ];
    return !blocked.some((re) => re.test(host));
  } catch {
    return false;
  }
}

const callbackRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: CallbackBody }>(
    '/payment/callback',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider_ref', 'status'],
          properties: {
            provider_ref: { type: 'string' },
            status: { type: 'string', enum: ['success', 'failed'] },
            channel: { type: 'string' },
            raw_payload: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              idempotent: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // HMAC-SHA256 signature verification
      if (env.OPERATOR_WEBHOOK_SECRET) {
        const signature = request.headers['x-webhook-signature'];
        if (!signature || typeof signature !== 'string') {
          return reply.status(401).send({ error: 'Missing webhook signature', statusCode: 401 });
        }
        const expected = crypto
          .createHmac('sha256', env.OPERATOR_WEBHOOK_SECRET)
          .update(JSON.stringify(request.body))
          .digest('hex');
        const trusted = `sha256=${expected}`;
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(trusted))) {
          fastify.log.warn({ provider_ref: request.body?.provider_ref }, 'Invalid webhook signature');
          return reply.status(401).send({ error: 'Invalid webhook signature', statusCode: 401 });
        }
      }

      const { provider_ref, status, raw_payload } = request.body;

      const { data: tx, error } = await fastify.supabase
        .from('transactions')
        .select('id, operator_id, status, operators(webhook_url)')
        .eq('provider_ref', provider_ref)
        .maybeSingle();

      if (error) {
        fastify.log.error({ err: error, provider_ref }, 'Callback DB lookup error');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      if (!tx) {
        fastify.log.warn({ provider_ref }, 'Callback for unknown provider_ref');
        return reply.status(404).send({ error: 'Transaction not found', statusCode: 404 });
      }

      // Idempotency — skip if already terminal
      if (tx.status === 'success' || tx.status === 'failed') {
        return reply.send({ ok: true, idempotent: true });
      }

      await fastify.supabase
        .from('transactions')
        .update({ status, callback_payload: raw_payload ?? null })
        .eq('id', tx.id);

      fastify.log.info({ transactionId: tx.id, provider_ref, status }, 'Transaction updated via callback');

      // Notify operator webhook — fire and forget
      const webhookUrl = (tx.operators as { webhook_url?: string } | null)?.webhook_url;
      if (webhookUrl && isSafeWebhookUrl(webhookUrl)) {
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'payment.status_update',
            transaction_id: tx.id,
            provider_ref,
            status,
          }),
        }).catch((err: unknown) => {
          fastify.log.warn({ err, webhookUrl }, 'Operator webhook delivery failed');
        });
      }

      return reply.send({ ok: true, idempotent: false });
    },
  );
};

export default callbackRoute;
