import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireActiveMerchant } from '../../lib/merchant-auth';
import { errorResponses } from '../../lib/error-schema';

const merchantBalanceRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/merchant/balance',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            currency: { type: 'string', enum: ['CDF', 'USD', 'USDT'] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              balance:  { type: 'number' },
              currency: { type: 'string' },
              mode:     { type: 'string' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) {
        return reply.status(auth.status).send(auth.error);
      }

      const merchantId = auth.payload.merchant_id;
      const currency = (request.query as { currency?: string })?.currency?.toUpperCase() ?? 'CDF';

      const { data: merchant, error: merchantError } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, mode')
        .eq('id', merchantId)
        .maybeSingle();

      if (merchantError || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // ── Compute merchant ledger balance (per currency) ─────────
      // Returns the merchant's own balance: credits (collects) minus
      // debits (settlements + payouts) for the requested currency.
      // This is the same calculation used by debit_merchant_for_payout
      // and process_merchant_settlement, ensuring the balance shown
      // here matches the balance used for payout authorization.
      //
      // NOTE: This is NOT the global Unipesa/Avada treasury float.
      // The previous implementation called getBalance() which returns
      // the aggregated provider balance — a critical business flaw
      // that let any merchant see and spend the entire platform float.
      const { data: ledgerRows, error: ledgerError } = await fastify.supabase
        .from('merchant_ledger_entries')
        .select('type, amount')
        .eq('merchant_id', merchantId)
        .eq('currency', currency);

      if (ledgerError) {
        fastify.log.error({ err: ledgerError, merchantId, currency }, '[balance] Ledger query failed');
        return reply.status(500).send({ error: 'Failed to compute merchant balance', statusCode: 500 });
      }

      const balance = (ledgerRows ?? []).reduce((sum, row) => {
        return row.type === 'credit' ? sum + Number(row.amount) : sum - Number(row.amount);
      }, 0);

      fastify.log.info({ merchantId, balance, currency, mode: merchant.mode }, '[balance] returned ledger balance');

      return reply.send({
        balance,
        currency,
        mode: merchant.mode,
      });
    },
  );
};

export default merchantBalanceRoute;
