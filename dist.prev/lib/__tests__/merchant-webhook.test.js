"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function source(relativePath) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), relativePath), 'utf8');
}
(0, node_test_1.describe)('merchant-webhook shared module', () => {
    const mod = source('src/lib/merchant-webhook.ts');
    (0, node_test_1.it)('exports notifyMerchantWebhook function', () => {
        strict_1.default.match(mod, /export async function notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('exports isSafeWebhookUrl function', () => {
        strict_1.default.match(mod, /export function isSafeWebhookUrl/);
    });
    (0, node_test_1.it)('fetches webhook_url and webhook_secret from merchants table', () => {
        strict_1.default.match(mod, /from\('merchants'\)/);
        strict_1.default.match(mod, /select\('webhook_url, webhook_secret'\)/);
    });
    (0, node_test_1.it)('signs payload with HMAC-SHA256 using webhook_secret', () => {
        strict_1.default.match(mod, /createHmac\('sha256', webhookSecret\)/);
        strict_1.default.match(mod, /X-UniPay-Signature/);
        strict_1.default.match(mod, /sha256=/);
    });
    (0, node_test_1.it)('uses sendWebhookWithRetry for delivery (fire-and-forget)', () => {
        strict_1.default.match(mod, /sendWebhookWithRetry/);
        strict_1.default.match(mod, /\.catch\(/);
    });
    (0, node_test_1.it)('builds payment.status_update event payload', () => {
        strict_1.default.match(mod, /event: 'payment\.status_update'/);
        strict_1.default.match(mod, /transaction_id/);
        strict_1.default.match(mod, /avada_transaction_id/);
        strict_1.default.match(mod, /reference/);
        strict_1.default.match(mod, /status/);
    });
    (0, node_test_1.it)('blocks SSRF: rejects localhost, private IPs, non-HTTPS', () => {
        strict_1.default.match(mod, /u\.protocol !== 'https:'.*return false/);
        strict_1.default.match(mod, /localhost/);
        strict_1.default.match(mod, /127/);
        strict_1.default.match(mod, /192/);
        strict_1.default.match(mod, /169/);
        strict_1.default.match(mod, /::1/);
    });
    (0, node_test_1.it)('returns false when no webhook URL is configured', () => {
        strict_1.default.match(mod, /if \(!webhookUrl\) return false/);
    });
    (0, node_test_1.it)('returns false and logs when webhook URL is unsafe', () => {
        strict_1.default.match(mod, /if \(!isSafeWebhookUrl\(webhookUrl\)\)/);
        strict_1.default.match(mod, /unsafe — skipping/);
        strict_1.default.match(mod, /return false/);
    });
});
(0, node_test_1.describe)('callback.ts uses shared merchant-webhook module', () => {
    const callback = source('src/routes/payment/callback.ts');
    (0, node_test_1.it)('imports notifyMerchantWebhook from lib/merchant-webhook', () => {
        strict_1.default.match(callback, /from '\.\.\/\.\.\/lib\/merchant-webhook'/);
        strict_1.default.match(callback, /notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('does NOT inline webhook delivery logic anymore (uses shared helper)', () => {
        // The inline SSRF guard and direct sendWebhookWithRetry call should be gone
        strict_1.default.doesNotMatch(callback, /function isSafeWebhookUrl/);
        strict_1.default.doesNotMatch(callback, /from '\.\.\/\.\.\/lib\/webhook-delivery'/);
    });
    (0, node_test_1.it)('calls notifyMerchantWebhook with the transaction and status', () => {
        strict_1.default.match(callback, /notifyMerchantWebhook\(fastify\.supabase/);
        strict_1.default.match(callback, /merchant_id: tx\.merchant_id/);
        strict_1.default.match(callback, /dbStatus/);
    });
});
(0, node_test_1.describe)('reconciliation worker uses shared merchant-webhook module', () => {
    const service = source('src/services/unipesa-reconciliation.ts');
    (0, node_test_1.it)('imports notifyMerchantWebhook from lib/merchant-webhook', () => {
        strict_1.default.match(service, /from '\.\.\/lib\/merchant-webhook'/);
        strict_1.default.match(service, /notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('fires webhook only when merchant_id is present and RPC processed', () => {
        strict_1.default.match(service, /if \(tx\.merchant_id\)/);
        strict_1.default.match(service, /void notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('does NOT inline webhook delivery logic (uses shared helper)', () => {
        strict_1.default.doesNotMatch(service, /function isSafeWebhookUrl/);
        strict_1.default.doesNotMatch(service, /from '\.\/webhook-delivery'/);
    });
});
(0, node_test_1.describe)('getTransactionStatusWithRaw — enriched status with diagnostic data', () => {
    const avada = source('src/services/avada.ts');
    (0, node_test_1.it)('exports getTransactionStatusWithRaw returning { status, raw }', () => {
        strict_1.default.match(avada, /export async function getTransactionStatusWithRaw/);
        strict_1.default.match(avada, /TransactionStatusResult/);
        strict_1.default.match(avada, /status: AvadaStatus/);
        strict_1.default.match(avada, /raw: Record<string, unknown>/);
    });
    (0, node_test_1.it)('getTransactionStatus delegates to getTransactionStatusWithRaw (backward-compatible)', () => {
        strict_1.default.match(avada, /export async function getTransactionStatus/);
        strict_1.default.match(avada, /const \{ status \} = await getTransactionStatusWithRaw/);
        strict_1.default.match(avada, /return status/);
    });
    (0, node_test_1.it)('getTransactionStatusWithRaw returns the full raw response object', () => {
        strict_1.default.match(avada, /return \{ status, raw: data \}/);
    });
    (0, node_test_1.it)('existing callers (airtel/orange/afrimoney) still use getTransactionStatus (unchanged)', () => {
        const airtel = source('src/services/airtel.ts');
        const orange = source('src/services/orange.ts');
        const afrimoney = source('src/services/afrimoney.ts');
        strict_1.default.match(airtel, /avada\.getTransactionStatus/);
        strict_1.default.match(orange, /avada\.getTransactionStatus/);
        strict_1.default.match(afrimoney, /avada\.getTransactionStatus/);
    });
});
(0, node_test_1.describe)('webhook idempotency — callback and reconciliation do not double-notify', () => {
    const callback = source('src/routes/payment/callback.ts');
    const service = source('src/services/unipesa-reconciliation.ts');
    (0, node_test_1.it)('callback only notifies when RPC returns processed: true', () => {
        // The callback checks result?.processed before notifying
        strict_1.default.match(callback, /if \(!result\?\.processed\)/);
        // The notify call is after the early-return for non-processed
        strict_1.default.match(callback, /notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('reconciliation only notifies when RPC returns processed: true', () => {
        // The reconciliation checks result?.processed before notifying
        strict_1.default.match(service, /if \(!result\?\.processed\)/);
        // The notify call is after the early-return for non-processed
        strict_1.default.match(service, /notifyMerchantWebhook/);
    });
    (0, node_test_1.it)('both use the same provider_event_id pattern for idempotency', () => {
        // The RPC's UNIQUE(provider, provider_event_id) ensures only one
        // of the two paths can get processed: true for a given event.
        // Callback uses avada_transaction_id; reconciliation uses
        // reconcile:<txId>:<status>. Different IDs, but the RPC also
        // checks already-terminal, so the second call is a no-op.
        strict_1.default.match(callback, /p_provider_event_id: avada_transaction_id/);
        strict_1.default.match(service, /reconcile:\$\{tx\.id\}:\$\{dbStatus\}/);
    });
});
//# sourceMappingURL=merchant-webhook.test.js.map