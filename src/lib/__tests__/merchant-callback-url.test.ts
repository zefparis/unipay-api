/**
 * Test: merchant callback URL is distinct from wallet callback URL.
 *
 * Bug: avada.ts (merchant flow) used env.UNIPESA_CALLBACK_URL, which is the
 * SAME variable used by unipesa.ts (wallet flow). If the env var points to
 * /v1/wallet/unipesa/callback, merchant transaction callbacks are misrouted.
 *
 * Fix: avada.ts now uses UNIPESA_MERCHANT_CALLBACK_URL (with fallback to
 * UNIPESA_CALLBACK_URL for backward compat).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const AVADA_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../services/avada.ts'),
  'utf-8',
);

const ENV_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../config/env.ts'),
  'utf-8',
);

const UNIPESA_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../lib/unipesa.ts'),
  'utf-8',
);

describe('merchant callback URL isolation', () => {
  it('avada.ts uses UNIPESA_MERCHANT_CALLBACK_URL (not UNIPESA_CALLBACK_URL)', () => {
    assert.match(
      AVADA_SRC,
      /UNIPESA_MERCHANT_CALLBACK_URL/,
      'avada.ts must use UNIPESA_MERCHANT_CALLBACK_URL',
    );
  });

  it('avada.ts falls back to UNIPESA_CALLBACK_URL for backward compat', () => {
    assert.match(
      AVADA_SRC,
      /env\.UNIPESA_MERCHANT_CALLBACK_URL\s*\?\?\s*env\.UNIPESA_CALLBACK_URL/,
      'avada.ts must fall back to UNIPESA_CALLBACK_URL if merchant URL is not set',
    );
  });

  it('avada.ts does NOT use UNIPESA_CALLBACK_URL as its primary source', () => {
    // The requireUnipesaEnv function should reference MERCHANT_CALLBACK_URL first
    const requireFnMatch = AVADA_SRC.match(
      /function requireUnipesaEnv[\s\S]*?return\s*\{[^}]*\};?\s*\}/,
    );
    assert.ok(requireFnMatch, 'must find requireUnipesaEnv function');
    assert.match(
      requireFnMatch[0],
      /UNIPESA_MERCHANT_CALLBACK_URL/,
      'requireUnipesaEnv must use UNIPESA_MERCHANT_CALLBACK_URL',
    );
  });

  it('unipesa.ts (wallet) still uses UNIPESA_CALLBACK_URL (unchanged)', () => {
    assert.match(
      UNIPESA_SRC,
      /UNIPESA_CALLBACK_URL/,
      'unipesa.ts must still use UNIPESA_CALLBACK_URL for wallet flow',
    );
    assert.doesNotMatch(
      UNIPESA_SRC,
      /UNIPESA_MERCHANT_CALLBACK_URL/,
      'unipesa.ts must NOT use the merchant callback URL',
    );
  });

  it('env.ts declares UNIPESA_MERCHANT_CALLBACK_URL', () => {
    assert.match(
      ENV_SRC,
      /UNIPESA_MERCHANT_CALLBACK_URL/,
      'env.ts must declare UNIPESA_MERCHANT_CALLBACK_URL',
    );
  });

  it('env.ts still declares UNIPESA_CALLBACK_URL (for wallet)', () => {
    assert.match(
      ENV_SRC,
      /UNIPESA_CALLBACK_URL/,
      'env.ts must still declare UNIPESA_CALLBACK_URL for wallet flow',
    );
  });

  it('.env.example documents both URLs with distinct paths', () => {
    const envExample = fs.readFileSync(
      path.resolve(__dirname, '../../../.env.example'),
      'utf-8',
    );
    assert.match(
      envExample,
      /UNIPESA_CALLBACK_URL.*wallet\/unipesa\/callback/,
      '.env.example must show UNIPESA_CALLBACK_URL pointing to wallet callback',
    );
    assert.match(
      envExample,
      /UNIPESA_MERCHANT_CALLBACK_URL.*payment\/callback/,
      '.env.example must show UNIPESA_MERCHANT_CALLBACK_URL pointing to payment callback',
    );
  });
});
