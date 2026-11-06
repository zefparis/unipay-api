"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWebhookSignature = buildWebhookSignature;
exports.sendWebhookWithRetry = sendWebhookWithRetry;
const node_crypto_1 = __importDefault(require("node:crypto"));
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 5_000, 30_000];
const TIMEOUT_MS = 10_000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Build the HMAC signature header for a webhook payload.
 */
function buildWebhookSignature(payload, secret) {
    const sig = node_crypto_1.default.createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${sig}`;
}
/**
 * Send a webhook with retry. Returns a promise that resolves when all
 * attempts are exhausted or one succeeds.
 *
 * @param url - The merchant webhook URL (already validated as safe)
 * @param payload - JSON-stringified body
 * @param headers - Headers including Content-Type and X-UniPay-Signature
 * @param log - Fastify logger instance (or console-compatible)
 */
async function sendWebhookWithRetry(url, payload, headers, log) {
    let lastError;
    let lastStatus;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: payload,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.ok) {
                // 2xx — success
                log.info({ attempt, maxAttempts: MAX_ATTEMPTS, statusCode: res.status, url }, 'Webhook delivered successfully');
                return { success: true, attempts: attempt, finalStatus: res.status };
            }
            // 4xx or 5xx — treat as failure, retry
            lastStatus = res.status;
            lastError = `HTTP ${res.status}`;
            log.warn({ attempt, maxAttempts: MAX_ATTEMPTS, statusCode: res.status, url }, 'Webhook delivery failed (non-2xx), will retry');
        }
        catch (err) {
            lastStatus = undefined;
            lastError = err instanceof Error ? err.message : String(err);
            log.warn({ attempt, maxAttempts: MAX_ATTEMPTS, error: lastError, url }, 'Webhook delivery failed (network/timeout), will retry');
        }
        // If not the last attempt, wait before retrying
        if (attempt < MAX_ATTEMPTS) {
            await sleep(BACKOFF_MS[attempt - 1]);
        }
    }
    // All attempts exhausted
    log.error({ url, attempts: MAX_ATTEMPTS, finalStatus: lastStatus, finalError: lastError }, 'Webhook delivery abandoned after all retries failed');
    return {
        success: false,
        attempts: MAX_ATTEMPTS,
        finalStatus: lastStatus,
        finalError: lastError,
    };
}
//# sourceMappingURL=webhook-delivery.js.map