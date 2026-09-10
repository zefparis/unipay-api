import type { FastifyPluginAsync } from 'fastify';
import { verifyCallbackSignature, normalizeCallback } from '../../services/avada';
import type { AvadaCallbackPayload } from '../../services/avada';
import { sendWalletDepositEmail } from '../../services/email';
import { validateProviderCallbackProof } from '../../lib/provider-callback-proof';
import { notifyMerchantWebhook } from '../../lib/merchant-webhook';

const callbackRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: AvadaCallbackPayload }>(
    '/payment/callback',
    {
      schema: {
        body: {
          type: 'object',
          required: ['order_id', 'transaction_id', 'status', 'customer_id', 'provider_id', 'amount'],
          properties: {
            order_id:       { type: 'string' },
            transaction_id: { type: 'string' },
            status:         { type: 'number' },
            customer_id:    { type: 'string' },
            provider_id:    { type: 'number' },
            amount:         { type: 'number' },
            currency:       { type: 'string' },
            merchant_id:    { type: 'string' },
            signature:      { type: 'string' },
          },
          additionalProperties: true,
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
      // Avada signature verification — signature is embedded in the body (AvadaPay HMAC-SHA512 spec)
      if (!request.body?.signature || !verifyCallbackSignature(request.body as Record<string, unknown>)) {
        fastify.log.warn({ transaction_id: request.body?.transaction_id }, 'Missing or invalid Avada signature');
        return reply.status(401).send({ error: 'Missing or invalid webhook signature', statusCode: 401 });
      }

      const normalized = normalizeCallback(request.body);
      const { avada_transaction_id, status, reference } = normalized;

      // Only process terminal states
      if (status !== 'success' && status !== 'failed' && status !== 'cancelled') {
        return reply.send({ ok: true, idempotent: true });
      }

      const dbStatus = status === 'cancelled' ? 'failed' : status;

      // Primary lookup: by avada_transaction_id
      // Fallback: by reference (our WD-XXXXXXXX order_id), in case Unipesa's
      // callback transaction_id differs from the one returned in the collection response
      let tx: {
        id: string;
        merchant_id: string;
        status: string;
        wallet_user_id?: string | null;
        direction?: string;
        amount: number;
        net_amount?: number;
        currency: string;
        phone: string;
        operator: string;
        reference: string | null;
      } | null = null;
      {
        const { data, error } = await fastify.supabase
          .from('transactions')
          .select('id, merchant_id, status, wallet_user_id, direction, amount, net_amount, currency, phone, operator, reference')
          .eq('avada_transaction_id', avada_transaction_id)
          .maybeSingle();
        if (error) {
          fastify.log.error({ err: error, avada_transaction_id }, 'Callback DB lookup error');
          return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        tx = data;
      }

      if (!tx && reference) {
        const { data, error } = await fastify.supabase
          .from('transactions')
          .select('id, merchant_id, status, wallet_user_id, direction, amount, net_amount, currency, phone, operator, reference')
          .eq('reference', reference)
          .maybeSingle();
        if (error) {
          fastify.log.error({ err: error, reference }, 'Callback DB lookup (by reference) error');
          return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        tx = data;
      }

      if (!tx) {
        fastify.log.warn({ avada_transaction_id, reference }, 'Callback for unknown transaction');
        return reply.status(404).send({ error: 'Transaction not found', statusCode: 404 });
      }

      const proof = validateProviderCallbackProof(
        {
          reference,
          amount: normalized.amount,
          phone: normalized.phone,
          operator: normalized.operator,
          currency: normalized.raw.currency,
        },
        {
          reference: tx.reference,
          amount: Number(tx.amount),
          phone: tx.phone,
          operator: tx.operator,
          currency: tx.currency,
        },
      );
      if (!proof.valid) {
        fastify.log.warn({ txId: tx.id, reason: proof.reason }, 'Provider callback does not match stored transaction');
        return reply.status(400).send({ error: 'Provider callback proof mismatch', statusCode: 400 });
      }

      const { data: callbackResult, error: callbackError } = await fastify.supabase.rpc(
        'process_wallet_provider_callback',
        {
          p_provider: 'unipesa',
          p_provider_event_id: avada_transaction_id,
          p_transaction_id: tx.id,
          p_new_status: dbStatus,
          p_provider_transaction_id: avada_transaction_id,
          p_payload: normalized.raw,
        },
      );

      if (callbackError) {
        fastify.log.error({ err: callbackError, txId: tx.id }, 'Atomic provider callback failed');
        return reply.status(500).send({ error: 'Callback processing failed', statusCode: 500 });
      }

      const result = callbackResult as { processed?: boolean; duplicate?: boolean; already_terminal?: boolean; credited?: number } | null;
      if (!result?.processed) {
        return reply.send({ ok: true, idempotent: true });
      }

      const walletUserId = tx.wallet_user_id;
      const txNetAmount = Number(tx.net_amount ?? 0);
      if (Number(result.credited ?? 0) > 0 && walletUserId) {
        const { data: walletRow } = await fastify.supabase
          .from('wallet_users')
          .select('email, full_name, lang')
          .eq('id', walletUserId)
          .maybeSingle();
        if (walletRow?.email) {
          sendWalletDepositEmail({
            to: walletRow.email, name: walletRow.full_name ?? '',
            amount: txNetAmount.toFixed(0), currency: tx.currency,
            method: 'Mobile Money', txRef: reference ?? tx.id,
            lang: walletRow.lang ?? 'fr',
          });
        }
      }

      fastify.log.info({ transactionId: tx.id, avada_transaction_id, status: dbStatus }, 'Transaction updated via Avada callback');

      // Notify merchant webhook — fire and forget, HMAC-signed.
      // Uses the shared notifyMerchantWebhook helper so the payload
      // shape and signing are identical whether the transaction was
      // resolved by an inbound callback or by the reconciliation worker.
      void notifyMerchantWebhook(fastify.supabase, {
        id: tx.id,
        merchant_id: tx.merchant_id,
        reference: tx.reference,
        avada_transaction_id,
      }, dbStatus, fastify.log);

      return reply.send({ ok: true, idempotent: false });
    },
  );
};

export default callbackRoute;
