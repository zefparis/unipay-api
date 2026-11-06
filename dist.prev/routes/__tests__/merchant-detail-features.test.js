"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Static-analysis regression tests for the three new merchant detail features:
 *
 * 1. POST /v1/admin/merchants/:id/settle — admin-triggered manual settlement
 * 2. GET /v1/admin/merchants/:id/stats — per-merchant success/failure stats
 * 3. POST /v1/admin/merchants/:id/test-callback — callback URL test
 *
 * These tests verify that the endpoints exist, use the correct imports,
 * and follow the same patterns as the existing merchant settlement flow.
 * Full integration tests would require a running Fastify + Supabase stack.
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const MERCHANTS_ROUTE = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/routes/admin/merchants.ts'), 'utf8');
const PROVIDER_OUTAGE_LIB = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/lib/provider-outage.ts'), 'utf8');
const STATUS_OPERATORS = node_fs_1.default.readFileSync(node_path_1.default.resolve(process.cwd(), 'src/routes/status/operators.ts'), 'utf8');
(0, node_test_1.describe)('Feature 1: Manual settlement trigger', () => {
    (0, node_test_1.it)('defines POST /admin/merchants/:id/settle endpoint', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/settle'/);
        strict_1.default.match(MERCHANTS_ROUTE, /post.*settle/i);
    });
    (0, node_test_1.it)('imports initiatePayout from avada service', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /import.*initiatePayout.*from.*avada/);
    });
    (0, node_test_1.it)('imports markSettlementSuccess and markSettlementFailed', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /markSettlementSuccess/);
        strict_1.default.match(MERCHANTS_ROUTE, /markSettlementFailed/);
    });
    (0, node_test_1.it)('calls process_merchant_settlement RPC (same as merchant flow)', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /process_merchant_settlement/);
    });
    (0, node_test_1.it)('validates KYC approved and mode live (same as merchant flow)', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /kyc_status.*approved/);
        strict_1.default.match(MERCHANTS_ROUTE, /mode.*live/);
    });
    (0, node_test_1.it)('validates settlement phone with isValidDrcPhone', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /isValidDrcPhone/);
    });
    (0, node_test_1.it)('uses normalizePhoneForOperator for payout', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /normalizePhoneForOperator/);
    });
    (0, node_test_1.it)('logs admin action via logAdminAction', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /logAdminAction.*merchant\.settle/);
    });
});
(0, node_test_1.describe)('Feature 2: Per-merchant stats with operator breakdown', () => {
    (0, node_test_1.it)('defines GET /admin/merchants/:id/stats endpoint', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/stats'/);
    });
    (0, node_test_1.it)('imports isProviderOutageFailure from shared lib', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /import.*isProviderOutageFailure.*from.*provider-outage/);
    });
    (0, node_test_1.it)('supports 7d and 30d window parameter', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /window.*7d.*30d/);
    });
    (0, node_test_1.it)('filters by merchant_id (per-merchant, not global)', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /eq\('merchant_id', id\)/);
    });
    (0, node_test_1.it)('returns per-operator breakdown with provider_outage_failures', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /provider_outage_failures/);
        strict_1.default.match(MERCHANTS_ROUTE, /client_error_failures/);
    });
    (0, node_test_1.it)('computes success_rate_pct', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /success_rate_pct/);
    });
});
(0, node_test_1.describe)('Feature 3: Webhook test (uses existing webhook_url column)', () => {
    (0, node_test_1.it)('defines POST /admin/merchants/:id/test-webhook endpoint', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/test-webhook'/);
    });
    (0, node_test_1.it)('defines PUT /admin/merchants/:id/webhook-url endpoint', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/webhook-url'/);
    });
    (0, node_test_1.it)('returns NO_WEBHOOK_URL error when no webhook configured', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /NO_WEBHOOK_URL/);
    });
    (0, node_test_1.it)('sends test payload with event: webhook.test', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /event:\s*['"]webhook\.test['"]/);
    });
    (0, node_test_1.it)('signs payload with webhook_secret (X-UniPay-Signature header)', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /webhook_secret/);
        strict_1.default.match(MERCHANTS_ROUTE, /X-UniPay-Signature/);
    });
    (0, node_test_1.it)('returns http_status, elapsed_ms, and body in response', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /http_status/);
        strict_1.default.match(MERCHANTS_ROUTE, /elapsed_ms/);
    });
    (0, node_test_1.it)('handles timeout with AbortController (10s)', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /AbortController/);
        strict_1.default.match(MERCHANTS_ROUTE, /10000/);
    });
    (0, node_test_1.it)('handles WEBHOOK_TIMEOUT error', () => {
        strict_1.default.match(MERCHANTS_ROUTE, /WEBHOOK_TIMEOUT/);
    });
    (0, node_test_1.it)('does NOT reference the non-existent callback_url column', () => {
        strict_1.default.doesNotMatch(MERCHANTS_ROUTE, /callback_url/);
    });
});
(0, node_test_1.describe)('Shared provider-outage lib', () => {
    (0, node_test_1.it)('exports isProviderOutageFailure function', () => {
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /export function isProviderOutageFailure/);
    });
    (0, node_test_1.it)('checks unipesa_result_code for 10301 and 10201', () => {
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /10301/);
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /10201/);
    });
    (0, node_test_1.it)('checks result.code (callback metadata)', () => {
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /result.*code/);
    });
    (0, node_test_1.it)('checks reason strings (API unreachable, get token error)', () => {
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /API unreachable/);
        strict_1.default.match(PROVIDER_OUTAGE_LIB, /get token error/);
    });
});
(0, node_test_1.describe)('status/operators.ts uses shared lib (no duplication)', () => {
    (0, node_test_1.it)('imports from shared lib', () => {
        strict_1.default.match(STATUS_OPERATORS, /import.*isProviderOutageFailure.*from.*provider-outage/);
    });
    (0, node_test_1.it)('does not define its own PROVIDER_OUTAGE_RESULT_CODES', () => {
        strict_1.default.doesNotMatch(STATUS_OPERATORS, /const PROVIDER_OUTAGE_RESULT_CODES/);
    });
    (0, node_test_1.it)('does not define its own isProviderOutageFailure function', () => {
        strict_1.default.doesNotMatch(STATUS_OPERATORS, /function isProviderOutageFailure/);
    });
});
//# sourceMappingURL=merchant-detail-features.test.js.map