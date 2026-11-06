/**
 * Webhook delivery with retry and exponential backoff.
 *
 * Attempts up to 3 times with delays of 1s, 5s, 30s between attempts.
 * A attempt is considered successful if the server responds with a 2xx
 * status code within the timeout period. Everything else (4xx, 5xx,
 * timeout, network error) triggers a retry, except after the 3rd attempt.
 *
 * This function is designed to be called WITHOUT await from the callback
 * handler — it runs entirely in the background and logs every attempt.
 */
export interface WebhookDeliveryResult {
    success: boolean;
    attempts: number;
    finalStatus?: number;
    finalError?: string;
}
/**
 * Build the HMAC signature header for a webhook payload.
 */
export declare function buildWebhookSignature(payload: string, secret: string): string;
/**
 * Send a webhook with retry. Returns a promise that resolves when all
 * attempts are exhausted or one succeeds.
 *
 * @param url - The merchant webhook URL (already validated as safe)
 * @param payload - JSON-stringified body
 * @param headers - Headers including Content-Type and X-UniPay-Signature
 * @param log - Fastify logger instance (or console-compatible)
 */
export declare function sendWebhookWithRetry(url: string, payload: string, headers: Record<string, string>, log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<WebhookDeliveryResult>;
