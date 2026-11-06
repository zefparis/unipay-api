"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSafeWebhookUrl = isSafeWebhookUrl;
exports.notifyMerchantWebhook = notifyMerchantWebhook;
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
const node_crypto_1 = __importDefault(require("node:crypto"));
const webhook_delivery_1 = require("./webhook-delivery");
// SSRF guard: only HTTPS to non-private/loopback hosts.
// Mirrors the guard in routes/merchant/webhook.ts.
function isSafeWebhookUrl(raw) {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:')
            return false;
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
    }
    catch {
        return false;
    }
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
async function notifyMerchantWebhook(supabase, tx, status, log) {
    const { data: merchantWebhook } = await supabase
        .from('merchants')
        .select('webhook_url, webhook_secret')
        .eq('id', tx.merchant_id)
        .maybeSingle();
    const webhookUrl = merchantWebhook?.webhook_url;
    if (!webhookUrl)
        return false;
    if (!isSafeWebhookUrl(webhookUrl)) {
        log.warn({ txId: tx.id, webhookUrl }, 'Merchant webhook URL is unsafe — skipping');
        return false;
    }
    const webhookSecret = merchantWebhook?.webhook_secret;
    // Fetch the transaction metadata to include the provider error
    // details (provider_result.code + provider_result.message) so the
    // merchant can display the real failure reason to their end user
    // (e.g. "PIN incorrect" vs "solde insuffisant" vs "opérateur
    // indisponible") instead of a generic "transaction failed".
    let providerResult = null;
    if (status === 'failed') {
        const { data: txRow } = await supabase
            .from('transactions')
            .select('metadata')
            .eq('id', tx.id)
            .maybeSingle();
        const md = txRow?.metadata;
        if (md && typeof md === 'object' && md['provider_result'] && typeof md['provider_result'] === 'object') {
            const pr = md['provider_result'];
            providerResult = {
                code: typeof pr['code'] === 'string' || typeof pr['code'] === 'number' ? String(pr['code']) : undefined,
                message: typeof pr['message'] === 'string' ? pr['message'] : undefined,
            };
        }
    }
    const payload = JSON.stringify({
        event: 'payment.status_update',
        timestamp: new Date().toISOString(),
        data: {
            transaction_id: tx.id,
            avada_transaction_id: tx.avada_transaction_id ?? null,
            reference: tx.reference,
            status,
            ...(providerResult ? { provider_result: providerResult } : {}),
        },
    });
    const headers = { 'Content-Type': 'application/json' };
    if (webhookSecret) {
        const sig = node_crypto_1.default.createHmac('sha256', webhookSecret).update(payload).digest('hex');
        headers['X-UniPay-Signature'] = `sha256=${sig}`;
    }
    // Fire retries in the background — do NOT await, so the caller
    // (callback route or reconciliation worker) is not delayed.
    (0, webhook_delivery_1.sendWebhookWithRetry)(webhookUrl, payload, headers, log).catch((err) => {
        log.error({ err, webhookUrl }, 'Webhook retry loop threw unexpectedly');
    });
    return true;
}
//# sourceMappingURL=merchant-webhook.js.map