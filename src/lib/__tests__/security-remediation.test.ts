import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Security remediation tests — 6 fixes from the audit.
 *
 * C2: merchant.status === 'active' check on all /v1/merchant/* routes
 * C5: HTML-escape email subject
 * C4: Rate limit on support message (10/hour per merchant_id)
 * C6: Rate limit on webhook test (5/hour per merchant_id)
 * L1: maxLength on admin search param
 * L2: schema.querystring on export transactions route
 */

const ROUTES_DIR = path.resolve(__dirname, '../../routes');
const LIB_DIR = path.resolve(__dirname, '../');
const EMAIL_SERVICE = path.resolve(__dirname, '../../services/email.ts');

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(ROUTES_DIR, rel), 'utf-8');
}

// ─── C2: merchant.status === 'active' check ───────────────────

describe('C2 — merchant.status check on all /v1/merchant/* routes', () => {
  const MERCHANT_AUTH_LIB = fs.readFileSync(
    path.resolve(LIB_DIR, 'merchant-auth.ts'),
    'utf-8',
  );

  it('merchant-auth.ts exports requireActiveMerchant that checks status === active', () => {
    assert.match(
      MERCHANT_AUTH_LIB,
      /data\.status !== 'active'/,
      'requireActiveMerchant must check status !== active',
    );
    assert.match(
      MERCHANT_AUTH_LIB,
      /Compte suspendu/,
      'must return "Compte suspendu" error message',
    );
  });

  it('balance.ts uses requireActiveMerchant (not inline verifyToken)', () => {
    const src = readSrc('merchant/balance.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
  });

  it('transactions.ts uses requireActiveMerchant (not inline verifyToken)', () => {
    const src = readSrc('merchant/transactions.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
  });

  it('apikey.ts uses requireActiveMerchant (not inline verifyToken)', () => {
    const src = readSrc('merchant/apikey.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
  });

  it('kyc.ts uses requireActiveMerchant (not inline verifyToken)', () => {
    const src = readSrc('merchant/kyc.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
  });

  it('mode.ts uses requireActiveMerchant for all 3 routes', () => {
    const src = readSrc('merchant/mode.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    // Count occurrences — should be at least 3 (one per route)
    const matches = src.match(/requireActiveMerchant/g);
    assert.ok(matches && matches.length >= 4, `expected ≥4 references (1 import + 3 routes), got ${matches?.length}`);
  });

  it('webhook.ts uses requireActiveMerchant for all 4 routes', () => {
    const src = readSrc('merchant/webhook.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /verifyToken/, 'must not use verifyToken directly');
    const matches = src.match(/requireActiveMerchant/g);
    assert.ok(matches && matches.length >= 5, `expected ≥5 references (1 import + 4 routes), got ${matches?.length}`);
  });

  it('settlement.ts uses requireActiveMerchant for all 4 routes', () => {
    const src = readSrc('merchant/settlement.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /requireMerchantAuth\b/, 'must not use old local requireMerchantAuth');
    const matches = src.match(/requireActiveMerchant/g);
    assert.ok(matches && matches.length >= 5, `expected ≥5 references (1 import + 4 routes), got ${matches?.length}`);
  });

  it('support.ts uses requireActiveMerchant for all 3 routes', () => {
    const src = readSrc('merchant/support.ts');
    assert.match(src, /requireActiveMerchant/, 'must import requireActiveMerchant');
    assert.doesNotMatch(src, /function requireMerchantAuth/, 'must not define local requireMerchantAuth');
    const matches = src.match(/requireActiveMerchant/g);
    assert.ok(matches && matches.length >= 4, `expected ≥4 references (1 import + 3 routes), got ${matches?.length}`);
  });
});

// ─── C5: HTML-escape email subject ────────────────────────────

describe('C5 — email subject HTML-escaped', () => {
  const EMAIL_SRC = fs.readFileSync(EMAIL_SERVICE, 'utf-8');

  it('subject is HTML-escaped in the layout template', () => {
    // The subject must go through .replace(/&/g, ...).replace(/</g, ...).replace(/>/g, ...)
    // in the <h2> block, not be inserted raw.
    assert.match(
      EMAIL_SRC,
      /\$\{subject\.replace\(\/&\/g.*?\.replace\(\/<\/g.*?\.replace\(\/>\/g/,
      'subject must be HTML-escaped in the template',
    );
  });

  it('subject is NOT inserted raw (no bare ${subject} in h2)', () => {
    // Check that there's no bare ${subject} without .replace in the h2 block
    const h2Block = EMAIL_SRC.match(/<h2[^>]*>[\s\S]*?<\/h2>/);
    if (h2Block) {
      assert.doesNotMatch(
        h2Block[0],
        /\$\{subject\}/,
        'subject must not be inserted raw in the h2 block',
      );
    }
  });
});

// ─── C4: Rate limit on support message ────────────────────────

describe('C4 — rate limit on POST /merchant/support/message', () => {
  const SRC = readSrc('merchant/support.ts');

  it('has a route-level rateLimit config', () => {
    assert.match(
      SRC,
      /rateLimit:\s*\{/,
      'must have rateLimit config on the route',
    );
  });

  it('limits to 10 per hour', () => {
    assert.match(
      SRC,
      /max:\s*10/,
      'must limit to 10 requests',
    );
    assert.match(
      SRC,
      /timeWindow:\s*['"]1 hour['"]/,
      'must use 1 hour time window',
    );
  });

  it('keyGenerator uses merchant_id from JWT, not just IP', () => {
    assert.match(
      SRC,
      /merchantIdFromRequest/,
      'must use merchantIdFromRequest for key generation',
    );
  });
});

// ─── C6: Rate limit on webhook test ───────────────────────────

describe('C6 — rate limit on POST /merchant/webhook/test', () => {
  const SRC = readSrc('merchant/webhook.ts');

  it('has a route-level rateLimit config on the test route', () => {
    // Find the test route section and verify it has rateLimit
    const testRouteSection = SRC.match(/\/merchant\/webhook\/test[\s\S]*?async/);
    assert.ok(testRouteSection, 'must find webhook/test route');
    assert.match(
      testRouteSection[0],
      /rateLimit:\s*\{/,
      'test route must have rateLimit config',
    );
  });

  it('limits to 5 per hour', () => {
    const testRouteSection = SRC.match(/\/merchant\/webhook\/test[\s\S]*?async/);
    assert.ok(testRouteSection);
    assert.match(
      testRouteSection[0],
      /max:\s*5/,
      'must limit to 5 requests',
    );
    assert.match(
      testRouteSection[0],
      /timeWindow:\s*['"]1 hour['"]/,
      'must use 1 hour time window',
    );
  });

  it('keyGenerator uses merchant_id from JWT, not just IP', () => {
    assert.match(
      SRC,
      /merchantIdFromRequest/,
      'must use merchantIdFromRequest for key generation',
    );
  });
});

// ─── L1: maxLength on search param ────────────────────────────

describe('L1 — maxLength on admin search param', () => {
  const SRC = readSrc('admin/merchants.ts');

  it('search param has maxLength constraint', () => {
    assert.match(
      SRC,
      /search:\s*\{\s*type:\s*['"]string['"]\s*,\s*maxLength:\s*\d+\s*\}/,
      'search must have a maxLength constraint',
    );
  });

  it('maxLength is reasonable (≤ 256)', () => {
    const match = SRC.match(/search:\s*\{\s*type:\s*['"]string['"]\s*,\s*maxLength:\s*(\d+)\s*\}/);
    assert.ok(match, 'must find maxLength value');
    const maxLen = parseInt(match[1], 10);
    assert.ok(maxLen <= 256, `maxLength ${maxLen} should be ≤ 256`);
    assert.ok(maxLen >= 32, `maxLength ${maxLen} should be ≥ 32`);
  });
});

// ─── L2: schema.querystring on export transactions ────────────

describe('L2 — schema.querystring on export transactions route', () => {
  const SRC = readSrc('admin/merchants.ts');

  it('export route has a schema.querystring definition', () => {
    // Find the export route section
    const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
    assert.ok(exportSection, 'must find export route');
    assert.match(
      exportSection[0],
      /schema:\s*\{[\s\S]*?querystring:/,
      'export route must have schema.querystring',
    );
  });

  it('export querystring validates merchant_id as uuid', () => {
    const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
    assert.ok(exportSection);
    assert.match(
      exportSection[0],
      /merchant_id:\s*\{\s*type:\s*['"]string['"]\s*,\s*format:\s*['"]uuid['"]/,
      'merchant_id must be validated as uuid',
    );
  });

  it('export querystring validates status as enum', () => {
    const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
    assert.ok(exportSection);
    assert.match(
      exportSection[0],
      /status:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:/,
      'status must be validated as enum',
    );
  });

  it('export querystring validates operator as enum', () => {
    const exportSection = SRC.match(/transactions\/export[\s\S]*?async\s*\(request/);
    assert.ok(exportSection);
    assert.match(
      exportSection[0],
      /operator:\s*\{\s*type:\s*['"]string['"]\s*,\s*enum:/,
      'operator must be validated as enum',
    );
  });
});
