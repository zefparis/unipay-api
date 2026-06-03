import type { FastifyPluginAsync } from 'fastify';

interface CallbackBody {
  provider_ref: string;
  status: 'success' | 'failed';
  channel?: string;
  raw_payload?: Record<string, unknown>;
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
      if (webhookUrl) {
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
