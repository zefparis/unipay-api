import type { SupabaseClient } from '@supabase/supabase-js';
export declare function isSafeWebhookUrl(raw: string): boolean;
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
export declare function notifyMerchantWebhook(supabase: SupabaseClient, tx: MerchantWebhookTx, status: string, log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<boolean>;
