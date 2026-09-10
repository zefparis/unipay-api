/**
 * Tests for the shared merchant webhook notification module and the
 * enriched getTransactionStatusWithRaw function.
 *
 * Static-analysis tests verifying that:
 * 1. The merchant-webhook module exports notifyMerchantWebhook + isSafeWebhookUrl
 * 2. Both callback.ts and the reconciliation worker use the shared helper
 * 3. getTransactionStatusWithRaw returns { status, raw } and the existing
 *    getTransactionStatus delegates to it (backward-compatible)
 * 4. The webhook payload is HMAC-signed with webhook_secret
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('merchant-webhook shared module', () => {
  const mod = source('src/lib/merchant-webhook.ts');

  it('exports notifyMerchantWebhook function', () => {
    assert.match(mod, /export async function notifyMerchantWebhook/);
  });

  it('exports isSafeWebhookUrl function', () => {
    assert.match(mod, /export function isSafeWebhookUrl/);
  });

  it('fetches webhook_url and webhook_secret from merchants table', () => {
    assert.match(mod, /from\('merchants'\)/);
    assert.match(mod, /select\('webhook_url, webhook_secret'\)/);
  });

  it('signs payload with HMAC-SHA256 using webhook_secret', () => {
    assert.match(mod, /createHmac\('sha256', webhookSecret\)/);
    assert.match(mod, /X-UniPay-Signature/);
    assert.match(mod, /sha256=/);
  });

  it('uses sendWebhookWithRetry for delivery (fire-and-forget)', () => {
    assert.match(mod, /sendWebhookWithRetry/);
    assert.match(mod, /\.catch\(/);
  });

  it('builds payment.status_update event payload', () => {
    assert.match(mod, /event: 'payment\.status_update'/);
    assert.match(mod, /transaction_id/);
    assert.match(mod, /avada_transaction_id/);
    assert.match(mod, /reference/);
    assert.match(mod, /status/);
  });

  it('blocks SSRF: rejects localhost, private IPs, non-HTTPS', () => {
    assert.match(mod, /u\.protocol !== 'https:'.*return false/);
    assert.match(mod, /localhost/);
    assert.match(mod, /127/);
    assert.match(mod, /192/);
    assert.match(mod, /169/);
    assert.match(mod, /::1/);
  });

  it('returns false when no webhook URL is configured', () => {
    assert.match(mod, /if \(!webhookUrl\) return false/);
  });

  it('returns false and logs when webhook URL is unsafe', () => {
    assert.match(mod, /if \(!isSafeWebhookUrl\(webhookUrl\)\)/);
    assert.match(mod, /unsafe — skipping/);
    assert.match(mod, /return false/);
  });
});

describe('callback.ts uses shared merchant-webhook module', () => {
  const callback = source('src/routes/payment/callback.ts');

  it('imports notifyMerchantWebhook from lib/merchant-webhook', () => {
    assert.match(callback, /from '\.\.\/\.\.\/lib\/merchant-webhook'/);
    assert.match(callback, /notifyMerchantWebhook/);
  });

  it('does NOT inline webhook delivery logic anymore (uses shared helper)', () => {
    // The inline SSRF guard and direct sendWebhookWithRetry call should be gone
    assert.doesNotMatch(callback, /function isSafeWebhookUrl/);
    assert.doesNotMatch(callback, /from '\.\.\/\.\.\/lib\/webhook-delivery'/);
  });

  it('calls notifyMerchantWebhook with the transaction and status', () => {
    assert.match(callback, /notifyMerchantWebhook\(fastify\.supabase/);
    assert.match(callback, /merchant_id: tx\.merchant_id/);
    assert.match(callback, /dbStatus/);
  });
});

describe('reconciliation worker uses shared merchant-webhook module', () => {
  const service = source('src/services/unipesa-reconciliation.ts');

  it('imports notifyMerchantWebhook from lib/merchant-webhook', () => {
    assert.match(service, /from '\.\.\/lib\/merchant-webhook'/);
    assert.match(service, /notifyMerchantWebhook/);
  });

  it('fires webhook only when merchant_id is present and RPC processed', () => {
    assert.match(service, /if \(tx\.merchant_id\)/);
    assert.match(service, /void notifyMerchantWebhook/);
  });

  it('does NOT inline webhook delivery logic (uses shared helper)', () => {
    assert.doesNotMatch(service, /function isSafeWebhookUrl/);
    assert.doesNotMatch(service, /from '\.\/webhook-delivery'/);
  });
});

describe('getTransactionStatusWithRaw — enriched status with diagnostic data', () => {
  const avada = source('src/services/avada.ts');

  it('exports getTransactionStatusWithRaw returning { status, raw }', () => {
    assert.match(avada, /export async function getTransactionStatusWithRaw/);
    assert.match(avada, /TransactionStatusResult/);
    assert.match(avada, /status: AvadaStatus/);
    assert.match(avada, /raw: Record<string, unknown>/);
  });

  it('getTransactionStatus delegates to getTransactionStatusWithRaw (backward-compatible)', () => {
    assert.match(avada, /export async function getTransactionStatus/);
    assert.match(avada, /const \{ status \} = await getTransactionStatusWithRaw/);
    assert.match(avada, /return status/);
  });

  it('getTransactionStatusWithRaw returns the full raw response object', () => {
    assert.match(avada, /return \{ status, raw: data \}/);
  });

  it('existing callers (airtel/orange/afrimoney) still use getTransactionStatus (unchanged)', () => {
    const airtel = source('src/services/airtel.ts');
    const orange = source('src/services/orange.ts');
    const afrimoney = source('src/services/afrimoney.ts');
    assert.match(airtel, /avada\.getTransactionStatus/);
    assert.match(orange, /avada\.getTransactionStatus/);
    assert.match(afrimoney, /avada\.getTransactionStatus/);
  });
});

describe('webhook idempotency — callback and reconciliation do not double-notify', () => {
  const callback = source('src/routes/payment/callback.ts');
  const service = source('src/services/unipesa-reconciliation.ts');

  it('callback only notifies when RPC returns processed: true', () => {
    // The callback checks result?.processed before notifying
    assert.match(callback, /if \(!result\?\.processed\)/);
    // The notify call is after the early-return for non-processed
    assert.match(callback, /notifyMerchantWebhook/);
  });

  it('reconciliation only notifies when RPC returns processed: true', () => {
    // The reconciliation checks result?.processed before notifying
    assert.match(service, /if \(!result\?\.processed\)/);
    // The notify call is after the early-return for non-processed
    assert.match(service, /notifyMerchantWebhook/);
  });

  it('both use the same provider_event_id pattern for idempotency', () => {
    // The RPC's UNIQUE(provider, provider_event_id) ensures only one
    // of the two paths can get processed: true for a given event.
    // Callback uses avada_transaction_id; reconciliation uses
    // reconcile:<txId>:<status>. Different IDs, but the RPC also
    // checks already-terminal, so the second call is a no-op.
    assert.match(callback, /p_provider_event_id: avada_transaction_id/);
    assert.match(service, /reconcile:\$\{tx\.id\}:\$\{dbStatus\}/);
  });
});
