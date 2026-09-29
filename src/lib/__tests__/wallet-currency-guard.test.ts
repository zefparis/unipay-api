import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Wallet CDF path hardening (review 2026-09-29):
 *   (a) POST /v1/wallet/withdraw and /v1/wallet/deposit reject currency != 'CDF'
 *       — Fastify returns 400 on enum violation before any provider call.
 *       Proven risk: request.currency flowed verbatim into the Unipesa
 *       payload while wallet_debit_with_kyc_limit always debits balance_cdf.
 *   (b) the 502 response no longer leaks provider internals via `detail`.
 *   (c) admin revenue metrics read AVADA_FEE_RATE / MERCHANT_FEE_RATE from env.
 */

const SRC = path.resolve(__dirname, '../../../src');

const WITHDRAW  = fs.readFileSync(path.resolve(SRC, 'routes/wallet/withdraw.ts'), 'utf-8');
const DEPOSIT   = fs.readFileSync(path.resolve(SRC, 'routes/wallet/deposit.ts'),  'utf-8');
const MERCHANTS = fs.readFileSync(path.resolve(SRC, 'routes/admin/merchants.ts'), 'utf-8');

// ── (a) currency enum guard ──────────────────────────────────

describe('currency guard — CDF only', () => {
  it('withdraw schema pins currency to enum ["CDF"]', () => {
    assert.match(WITHDRAW, /currency:\s*\{\s*type:\s*'string',\s*enum:\s*\['CDF'\],\s*default:\s*'CDF'\s*\}/);
  });

  it('deposit schema pins currency to enum ["CDF"]', () => {
    assert.match(DEPOSIT, /currency:\s*\{\s*type:\s*'string',\s*enum:\s*\['CDF'\],\s*default:\s*'CDF'\s*\}/);
  });

  it('withdraw schema has no unconstrained currency length fallback', () => {
    assert.doesNotMatch(WITHDRAW, /currency:\s*\{[^}]*minLength/);
  });
});

// ── (b) no provider internals in the 502 body ────────────────

describe('withdraw 502 — no provider detail leak', () => {
  it('does not send errMsg/detail to the client', () => {
    const reply502 = WITHDRAW.match(/reply\.status\(502\)\.send\(\{[\s\S]*?\}\)/);
    assert.ok(reply502, 'expected a 502 reply block');
    assert.doesNotMatch(reply502[0], /detail|errMsg/);
  });

  it('still logs the full provider error server-side (both refund and ambiguous paths)', () => {
    const logs = WITHDRAW.match(/log\.error\(\s*\{ err: errMsg[^}]*\}/g) ?? [];
    assert.ok(logs.length >= 2, `expected errMsg logged on both provider-failure paths, found ${logs.length}`);
  });
});

// ── (c) admin revenue rates come from env ────────────────────

describe('admin merchants — env-driven rates', () => {
  it('AVADA_FEE_RATE reads env.AVADA_FEE_RATE', () => {
    assert.match(MERCHANTS, /AVADA_FEE_RATE\s*=\s*Number\(env\.AVADA_FEE_RATE\)/);
  });

  it('CLIENT_FEE_RATE reads env.MERCHANT_FEE_RATE', () => {
    assert.match(MERCHANTS, /CLIENT_FEE_RATE\s*=\s*Number\(env\.MERCHANT_FEE_RATE\)/);
  });

  it('no hardcoded fee-rate literal remains in revenue computation', () => {
    assert.doesNotMatch(MERCHANTS, /AVADA_FEE_RATE\s*=\s*0\.03/);
  });
});
