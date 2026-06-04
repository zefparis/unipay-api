import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { getProviderService } from '../../services/index';
import type { Channel, Direction } from '../../types/payment';

const FEE_RATE = 0.03; // 3% per signed contract with Avada Group RDC

interface InitiateBody {
  operator: Channel;
  direction: Direction;
  amount: number;
  currency: string;
  phone: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

const initiateRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: InitiateBody }>(
    '/payment/initiate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['operator', 'direction', 'amount', 'currency', 'phone'],
          properties: {
            operator: { type: 'string', enum: ['vodacash', 'orange', 'airtel', 'afrimoney', 'usdt'] },
            direction: { type: 'string', enum: ['collect', 'payout'] },
            amount: { type: 'number', minimum: 1 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            phone: { type: 'string', pattern: '^\\+?[1-9]\\d{7,14}$' },
            reference: { type: 'string', maxLength: 128 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              transaction_id: { type: 'string' },
              status: { type: 'string' },
              amount: { type: 'number' },
              fee: { type: 'number' },
              net_amount: { type: 'number' },
              currency: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { operator, direction, amount, currency, phone, reference, metadata } = request.body;
      const merchantId = request.operatorId;

      // Vodacash — direct integration pending due diligence with Vodacom DRC
      if (operator === 'vodacash') {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Vodacash integration is not yet available. CGL is currently in due diligence with Vodacom DRC.',
          statusCode: 503,
        });
      }

      const fee = Math.round(amount * FEE_RATE * 100) / 100;
      const net_amount = Math.round((amount - fee) * 100) / 100;
      const transactionId = crypto.randomUUID();
      const resolvedReference = reference ?? `TXN-${transactionId.slice(0, 8).toUpperCase()}`;

      // 1. Persist transaction as pending
      const { error: insertError } = await fastify.supabase
        .from('transactions')
        .insert({
          id: transactionId,
          merchant_id: merchantId,
          operator,
          direction,
          amount,
          fee,
          net_amount,
          currency,
          phone,
          reference: resolvedReference,
          status: 'pending',
          metadata: metadata ?? {},
        });

      if (insertError) {
        fastify.log.error({ err: insertError, transactionId }, 'DB insert failed');
        return reply.status(500).send({ error: 'Failed to create transaction', statusCode: 500 });
      }

      // 2. Call provider service
      const service = getProviderService(operator);
      try {
        const providerRes = await service.initiatePayment({
          transaction_id: transactionId,
          amount,
          currency,
          phone,
          direction,
          reference: resolvedReference,
        });

        await fastify.supabase
          .from('transactions')
          .update({ status: 'processing', avada_transaction_id: providerRes.provider_ref })
          .eq('id', transactionId);

        return reply.status(201).send({
          transaction_id: transactionId,
          status: 'processing',
          amount,
          fee,
          net_amount,
          currency,
        });
      } catch (err) {
        fastify.log.error({ err, transactionId, operator }, 'Provider error');
        await fastify.supabase
          .from('transactions')
          .update({ status: 'failed' })
          .eq('id', transactionId);
        return reply.status(502).send({ error: 'Provider service unavailable', statusCode: 502 });
      }
    },
  );
};

export default initiateRoute;
