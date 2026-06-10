import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { verifyCallbackSignature, normalizeCallback } from '../../services/avada';
import type { AvadaCallbackPayload } from '../../services/avada';
import { sendWalletDepositEmail } from '../../services/email';

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
      if (request.body && 'signature' in request.body) {
        if (!verifyCallbackSignature(request.body as Record<string, unknown>)) {
          fastify.log.warn({ transaction_id: request.body?.transaction_id }, 'Invalid Avada signature');
          return reply.status(401).send({ error: 'Invalid webhook signature', statusCode: 401 });
        }
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
      let tx: { id: string; merchant_id: string; status: string; wallet_user_id?: string | null; direction?: string; net_amount?: number } | null = null;
      {
        const { data, error } = await fastify.supabase
          .from('transactions')
          .select('id, merchant_id, status, wallet_user_id, direction, net_amount')
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
          .select('id, merchant_id, status, wallet_user_id, direction, net_amount')
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

      // Idempotency — skip if already terminal
      if (tx.status === 'success' || tx.status === 'failed') {
        return reply.send({ ok: true, idempotent: true });
      }

      await fastify.supabase
        .from('transactions')
        .update({ status: dbStatus, metadata: normalized.raw })
        .eq('id', tx.id);

      // ── Wallet balance credit (deposit confirmed) ─────────────
      const walletUserId = (tx as { wallet_user_id?: string | null }).wallet_user_id;
      const txDirection  = (tx as { direction?: string }).direction;
      const txNetAmount  = Number((tx as { net_amount?: number }).net_amount ?? 0);

      if (dbStatus === 'success' && txDirection === 'collect' && walletUserId) {
        const { data: walletRow } = await fastify.supabase
          .from('wallet_users')
          .select('balance_cdf, email, full_name, lang')
          .eq('id', walletUserId)
          .maybeSingle();

        if (walletRow) {
          // Deposits only credit the CDF balance. Converting CDF to CGLT is now
          // an explicit user action handled by the swap route.
          const { error: creditError } = await fastify.supabase
            .from('wallet_users')
            .update({
              balance_cdf: Number(walletRow.balance_cdf ?? 0) + txNetAmount,
            })
            .eq('id', walletUserId);

          if (creditError) {
            fastify.log.error(
              { err: creditError, walletUserId, txId: tx.id },
              '[wallet-credit] balance credit failed — manual reconciliation required',
            );
          } else {
            fastify.log.info(
              { walletUserId, netAmount: txNetAmount, txId: tx.id },
              '[wallet-credit] balance credited',
            );
            // Send deposit confirmation email (fire-and-forget)
            const wr = walletRow as unknown as { email?: string; full_name?: string; lang?: string };
            if (wr?.email) {
              sendWalletDepositEmail({
                to: wr.email, name: wr.full_name ?? '',
                amount: txNetAmount.toFixed(0), currency: 'CDF',
                method: 'Mobile Money', txRef: reference ?? tx.id,
                lang: wr.lang ?? 'fr',
              });
            }
          }
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
        fetch(webhookUrl, { method: 'POST', headers, body: payload }).catch((err: unknown) => {
          fastify.log.warn({ err, webhookUrl }, 'Merchant webhook delivery failed');
        });
      }

      return reply.send({ ok: true, idempotent: false });
    },
  );
};

export default callbackRoute;
