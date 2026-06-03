import { randomUUID } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import { getProviderService } from '../../services/index';
import type { Channel, Direction } from '../../types/payment';

interface InitiateBody {
  channel: Channel;
  direction: Direction;
  amount: number;
  currency: string;
  phone: string;
  metadata?: Record<string, unknown>;
}

const initiateRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: InitiateBody }>(
    '/payment/initiate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['channel', 'direction', 'amount', 'currency', 'phone'],
          properties: {
            channel: { type: 'string', enum: ['vodacash', 'orange', 'airtel', 'afrimoney', 'usdt'] },
            direction: { type: 'string', enum: ['deposit', 'withdraw'] },
            amount: { type: 'number', minimum: 0.01 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            phone: { type: 'string', minLength: 9, maxLength: 16 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              transaction_id: { type: 'string' },
              status: { type: 'string' },
              provider_ref: { type: 'string' },
              created_at: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { channel, direction, amount, currency, phone, metadata } = request.body;
      const operatorId = request.operatorId;
      const transactionId = randomUUID();

      // 1. Persist transaction as pending
      const { data: tx, error: insertError } = await fastify.supabase
        .from('transactions')
        .insert({
          id: transactionId,
          operator_id: operatorId,
          channel,
          direction,
          amount_usd: amount,
          amount_local: amount,
          currency,
          phone,
          status: 'pending',
          callback_payload: metadata ?? null,
        })
        .select('created_at')
        .single();

      if (insertError) {
        fastify.log.error({ err: insertError, transactionId }, 'DB insert failed');
        return reply.status(500).send({ error: 'Failed to create transaction', statusCode: 500 });
      }

      // 2. Call provider service stub
      const service = getProviderService(channel);
      try {
        const providerRes = await service.initiatePayment({
          transaction_id: transactionId,
          amount,
          currency,
          phone,
          direction,
        });

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing', provider_ref: providerRes.provider_ref })
          .eq('id', transactionId);

        return reply.status(201).send({
          transaction_id: transactionId,
          status: 'processing',
          provider_ref: providerRes.provider_ref,
          created_at: tx.created_at,
        });
      } catch (err) {
        fastify.log.error({ err, transactionId, channel }, 'Provider error');
        await fastify.supabase
          .from('transactions')
          .update({ status: 'failed', error_message: String(err) })
          .eq('id', transactionId);
        return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
      }
    },
  );
};

export default initiateRoute;
