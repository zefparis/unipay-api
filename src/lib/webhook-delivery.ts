import crypto from 'node:crypto';

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

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 5_000, 30_000];
const TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the HMAC signature header for a webhook payload.
 */
export function buildWebhookSignature(payload: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
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
export async function sendWebhookWithRetry(
  url: string,
  payload: string,
  headers: Record<string, string>,
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  },
): Promise<WebhookDeliveryResult> {
  let lastError: string | undefined;
  let lastStatus: number | undefined;

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
        log.info(
          { attempt, maxAttempts: MAX_ATTEMPTS, statusCode: res.status, url },
          'Webhook delivered successfully',
        );
        return { success: true, attempts: attempt, finalStatus: res.status };
      }

      // 4xx or 5xx — treat as failure, retry
      lastStatus = res.status;
      lastError = `HTTP ${res.status}`;
      log.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, statusCode: res.status, url },
        'Webhook delivery failed (non-2xx), will retry',
      );
    } catch (err: unknown) {
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, error: lastError, url },
        'Webhook delivery failed (network/timeout), will retry',
      );
    }

    // If not the last attempt, wait before retrying
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_MS[attempt - 1]);
    }
  }

  // All attempts exhausted
  log.error(
    { url, attempts: MAX_ATTEMPTS, finalStatus: lastStatus, finalError: lastError },
    'Webhook delivery abandoned after all retries failed',
  );

  return {
    success: false,
    attempts: MAX_ATTEMPTS,
    finalStatus: lastStatus,
    finalError: lastError,
  };
}
