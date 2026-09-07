import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { verifyCallbackSignature, normalizeCallback } from '../../services/avada';
import type { AvadaCallbackPayload } from '../../services/avada';
import { sendWalletDepositEmail } from '../../services/email';
import { validateProviderCallbackProof } from '../../lib/provider-callback-proof';
import { sendWebhookWithRetry } from '../../lib/webhook-delivery';

// SSRF guard: only HTTPS to non-private/loopback hosts
function isSafeWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname;
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

      // Notify merchant webhook — fire and forget, HMAC-signed
      const { data: merchantWebhook } = await fastify.supabase
        .from('merchants')
        .select('webhook_url, webhook_secret')
        .eq('id', tx.merchant_id)
        .maybeSingle();

      const webhookUrl = (merchantWebhook as { webhook_url?: string } | null)?.webhook_url;
      if (webhookUrl && isSafeWebhookUrl(webhookUrl)) {
        const webhookSecret = (merchantWebhook as { webhook_secret?: string } | null)?.webhook_secret;
        const payload = JSON.stringify({
          event: 'payment.status_update',
          timestamp: new Date().toISOString(),
          data: {
            transaction_id: tx.id,
            avada_transaction_id,
            reference,
            status: dbStatus,
          },
        });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (webhookSecret) {
          const sig = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
          headers['X-UniPay-Signature'] = `sha256=${sig}`;
        }
        // Fire retries in the background — do NOT await, so the callback
        // response to Avada is not delayed by webhook delivery attempts.
        sendWebhookWithRetry(webhookUrl, payload, headers, fastify.log).catch((err: unknown) => {
          fastify.log.error({ err, webhookUrl }, 'Webhook retry loop threw unexpectedly');
        });
      }

      return reply.send({ ok: true, idempotent: false });
    },
  );
};

export default callbackRoute;
