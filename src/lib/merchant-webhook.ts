/**
 * Shared merchant webhook notification.
 *
 * Used by both the inbound callback route (payment/callback.ts) and
 * the reconciliation worker (services/unipesa-reconciliation.ts) so
 * that a transaction resolved by EITHER path triggers the merchant
 * webhook with identical payload shape and HMAC signing.
 *
 * Idempotency: the caller must only invoke this when the underlying
 * status update was actually applied (i.e. the RPC returned
 * `processed: true`). The RPC's UNIQUE(provider, provider_event_id)
 * constraint ensures the status update itself is idempotent; this
 * webhook send is the side-effect of that first successful update.
 */
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWebhookWithRetry } from './webhook-delivery';

// SSRF guard: only HTTPS to non-private/loopback hosts.
// Mirrors the guard in routes/merchant/webhook.ts.
export function isSafeWebhookUrl(raw: string): boolean {
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

export interface MerchantWebhookTx {
  id: string;
  merchant_id: string;
  reference: string | null;
  avada_transaction_id?: string | null;
}

/**
 * Notify a merchant's webhook of a transaction status change.
 *
 * Fetches the merchant's webhook_url + webhook_secret, builds the
 * `payment.status_update` payload, signs it with HMAC-SHA256, and
 * fires the delivery in the background (fire-and-forget, like the
 * callback route does). Does NOT throw on delivery failure — errors
 * are logged via the provided logger.
 *
 * @returns true if a webhook was dispatched, false if skipped
 *          (no URL configured, unsafe URL, or no merchant found).
 */
export async function notifyMerchantWebhook(
  supabase: SupabaseClient,
  tx: MerchantWebhookTx,
  status: string,
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  },
): Promise<boolean> {
  const { data: merchantWebhook } = await supabase
    .from('merchants')
    .select('webhook_url, webhook_secret')
    .eq('id', tx.merchant_id)
    .maybeSingle();

  const webhookUrl = (merchantWebhook as { webhook_url?: string } | null)?.webhook_url;
  if (!webhookUrl) return false;
  if (!isSafeWebhookUrl(webhookUrl)) {
    log.warn({ txId: tx.id, webhookUrl }, 'Merchant webhook URL is unsafe — skipping');
    return false;
  }

  const webhookSecret = (merchantWebhook as { webhook_secret?: string } | null)?.webhook_secret;
  const payload = JSON.stringify({
    event: 'payment.status_update',
    timestamp: new Date().toISOString(),
    data: {
      transaction_id: tx.id,
      avada_transaction_id: tx.avada_transaction_id ?? null,
      reference: tx.reference,
      status,
    },
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (webhookSecret) {
    const sig = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
    headers['X-UniPay-Signature'] = `sha256=${sig}`;
  }

  // Fire retries in the background — do NOT await, so the caller
  // (callback route or reconciliation worker) is not delayed.
  sendWebhookWithRetry(webhookUrl, payload, headers, log).catch((err: unknown) => {
    log.error({ err, webhookUrl }, 'Webhook retry loop threw unexpectedly');
  });

  return true;
}
