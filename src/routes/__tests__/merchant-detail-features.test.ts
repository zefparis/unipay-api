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
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MERCHANTS_ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), 'src/routes/admin/merchants.ts'),
  'utf8',
);

const PROVIDER_OUTAGE_LIB = fs.readFileSync(
  path.resolve(process.cwd(), 'src/lib/provider-outage.ts'),
  'utf8',
);

const STATUS_OPERATORS = fs.readFileSync(
  path.resolve(process.cwd(), 'src/routes/status/operators.ts'),
  'utf8',
);

describe('Feature 1: Manual settlement trigger', () => {
  it('defines POST /admin/merchants/:id/settle endpoint', () => {
    assert.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/settle'/);
    assert.match(MERCHANTS_ROUTE, /post.*settle/i);
  });

  it('imports initiatePayout from avada service', () => {
    assert.match(MERCHANTS_ROUTE, /import.*initiatePayout.*from.*avada/);
  });

  it('imports markSettlementSuccess and markSettlementFailed', () => {
    assert.match(MERCHANTS_ROUTE, /markSettlementSuccess/);
    assert.match(MERCHANTS_ROUTE, /markSettlementFailed/);
  });

  it('calls process_merchant_settlement RPC (same as merchant flow)', () => {
    assert.match(MERCHANTS_ROUTE, /process_merchant_settlement/);
  });

  it('validates KYC approved and mode live (same as merchant flow)', () => {
    assert.match(MERCHANTS_ROUTE, /kyc_status.*approved/);
    assert.match(MERCHANTS_ROUTE, /mode.*live/);
  });

  it('validates settlement phone with isValidDrcPhone', () => {
    assert.match(MERCHANTS_ROUTE, /isValidDrcPhone/);
  });

  it('uses normalizePhoneForOperator for payout', () => {
    assert.match(MERCHANTS_ROUTE, /normalizePhoneForOperator/);
  });

  it('logs admin action via logAdminAction', () => {
    assert.match(MERCHANTS_ROUTE, /logAdminAction.*merchant\.settle/);
  });
});

describe('Feature 2: Per-merchant stats with operator breakdown', () => {
  it('defines GET /admin/merchants/:id/stats endpoint', () => {
    assert.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/stats'/);
  });

  it('imports isProviderOutageFailure from shared lib', () => {
    assert.match(MERCHANTS_ROUTE, /import.*isProviderOutageFailure.*from.*provider-outage/);
  });

  it('supports 7d and 30d window parameter', () => {
    assert.match(MERCHANTS_ROUTE, /window.*7d.*30d/);
  });

  it('filters by merchant_id (per-merchant, not global)', () => {
    assert.match(MERCHANTS_ROUTE, /eq\('merchant_id', id\)/);
  });

  it('returns per-operator breakdown with provider_outage_failures', () => {
    assert.match(MERCHANTS_ROUTE, /provider_outage_failures/);
    assert.match(MERCHANTS_ROUTE, /client_error_failures/);
  });

  it('computes success_rate_pct', () => {
    assert.match(MERCHANTS_ROUTE, /success_rate_pct/);
  });
});

describe('Feature 3: Webhook test (uses existing webhook_url column)', () => {
  it('defines POST /admin/merchants/:id/test-webhook endpoint', () => {
    assert.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/test-webhook'/);
  });

  it('defines PUT /admin/merchants/:id/webhook-url endpoint', () => {
    assert.match(MERCHANTS_ROUTE, /'\/admin\/merchants\/:id\/webhook-url'/);
  });

  it('returns NO_WEBHOOK_URL error when no webhook configured', () => {
    assert.match(MERCHANTS_ROUTE, /NO_WEBHOOK_URL/);
  });

  it('sends test payload with event: webhook.test', () => {
    assert.match(MERCHANTS_ROUTE, /event:\s*['"]webhook\.test['"]/);
  });

  it('signs payload with webhook_secret (X-UniPay-Signature header)', () => {
    assert.match(MERCHANTS_ROUTE, /webhook_secret/);
    assert.match(MERCHANTS_ROUTE, /X-UniPay-Signature/);
  });

  it('returns http_status, elapsed_ms, and body in response', () => {
    assert.match(MERCHANTS_ROUTE, /http_status/);
    assert.match(MERCHANTS_ROUTE, /elapsed_ms/);
  });

  it('handles timeout with AbortController (10s)', () => {
    assert.match(MERCHANTS_ROUTE, /AbortController/);
    assert.match(MERCHANTS_ROUTE, /10000/);
  });

  it('handles WEBHOOK_TIMEOUT error', () => {
    assert.match(MERCHANTS_ROUTE, /WEBHOOK_TIMEOUT/);
  });

  it('does NOT reference the non-existent callback_url column', () => {
    assert.doesNotMatch(MERCHANTS_ROUTE, /callback_url/);
  });
});

describe('Shared provider-outage lib', () => {
  it('exports isProviderOutageFailure function', () => {
    assert.match(PROVIDER_OUTAGE_LIB, /export function isProviderOutageFailure/);
  });

  it('checks unipesa_result_code for 10301 and 10201', () => {
    assert.match(PROVIDER_OUTAGE_LIB, /10301/);
    assert.match(PROVIDER_OUTAGE_LIB, /10201/);
  });

  it('checks result.code (callback metadata)', () => {
    assert.match(PROVIDER_OUTAGE_LIB, /result.*code/);
  });

  it('checks reason strings (API unreachable, get token error)', () => {
    assert.match(PROVIDER_OUTAGE_LIB, /API unreachable/);
    assert.match(PROVIDER_OUTAGE_LIB, /get token error/);
  });
});

describe('status/operators.ts uses shared lib (no duplication)', () => {
  it('imports from shared lib', () => {
    assert.match(STATUS_OPERATORS, /import.*isProviderOutageFailure.*from.*provider-outage/);
  });

  it('does not define its own PROVIDER_OUTAGE_RESULT_CODES', () => {
    assert.doesNotMatch(STATUS_OPERATORS, /const PROVIDER_OUTAGE_RESULT_CODES/);
  });

  it('does not define its own isProviderOutageFailure function', () => {
    assert.doesNotMatch(STATUS_OPERATORS, /function isProviderOutageFailure/);
  });
});
