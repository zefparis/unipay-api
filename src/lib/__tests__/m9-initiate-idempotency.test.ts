import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M9 remediation tests — idempotency on /payment/initiate.
 *
 * Verifies:
 *   - Migration adds UNIQUE constraint on (merchant_id, reference)
 *   - initiate.ts checks for existing transaction with same reference
 *   - Non-terminal existing transaction returns idempotent 201
 *   - Terminal existing transaction returns 409 DUPLICATE_REFERENCE
 *   - Auto-generated references skip the check
 */

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const INITIATE = fs.readFileSync(path.resolve(SRC, 'routes/payment/initiate.ts'), 'utf-8');
const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260924000000_initiate_idempotency.sql'),
  'utf-8',
);

// ── Migration tests ──────────────────────────────────────────

describe('M9-migration — UNIQUE constraint on (merchant_id, reference)', () => {
  it('creates a unique index on (merchant_id, reference)', () => {
    assert.match(
      MIGRATION,
      /CREATE UNIQUE INDEX IF NOT EXISTS transactions_merchant_reference_unique/i,
    );
  });

  it('index is on (merchant_id, reference)', () => {
    assert.match(
      MIGRATION,
      /ON public\.transactions \(merchant_id, reference\)/i,
    );
  });

  it('index is partial — only when reference IS NOT NULL', () => {
    assert.match(MIGRATION, /WHERE reference IS NOT NULL/i);
  });

  it('contains a pre-migration duplicate check query (commented)', () => {
    assert.match(MIGRATION, /HAVING count\(\*\) > 1/);
    assert.match(MIGRATION, /GROUP BY merchant_id, reference/);
  });
});

// ── initiate.ts tests ────────────────────────────────────────

describe('M9-initiate — idempotency check', () => {
  it('checks for existing transaction with same (merchant_id, reference)', () => {
    assert.match(INITIATE, /Idempotency check/i);
    assert.match(INITIATE, /\.eq\('merchant_id', merchantId\)/);
    assert.match(INITIATE, /\.eq\('reference', resolvedReference\)/);
    assert.match(INITIATE, /\.maybeSingle\(\)/);
  });

  it('only checks when reference is explicitly provided (not auto-generated)', () => {
    assert.match(INITIATE, /if \(reference !== undefined\)/);
  });

  it('returns existing transaction with idempotent: true for non-terminal status', () => {
    assert.match(INITIATE, /status === 'pending' \|\| existingTx\.status === 'processing'/);
    assert.match(INITIATE, /idempotent: true/);
    assert.match(INITIATE, /Idempotent replay/i);
  });

  it('returns 409 DUPLICATE_REFERENCE for terminal status', () => {
    assert.match(INITIATE, /DUPLICATE_REFERENCE/);
    assert.match(INITIATE, /409/);
    assert.match(INITIATE, /existing_transaction_id/);
    assert.match(INITIATE, /existing_status/);
  });

  it('response schema includes idempotent field', () => {
    assert.match(INITIATE, /idempotent:\s*\{\s*type:\s*'boolean'/);
  });

  it('idempotent return happens BEFORE the sandbox/live insert path', () => {
    // The idempotency check should be before the transaction insert
    const idempotencyPos = INITIATE.indexOf('Idempotency check');
    const insertPos = INITIATE.indexOf("from('transactions')\n        .insert(");
    assert.ok(idempotencyPos > -1, 'must find idempotency check');
    assert.ok(insertPos > -1, 'must find transaction insert');
    assert.ok(
      idempotencyPos < insertPos,
      'idempotency check must run BEFORE transaction insert',
    );
  });

  it('does NOT check idempotency for auto-generated references', () => {
    // The check is guarded by `if (reference !== undefined)`
    // Auto-generated references come from `reference ?? TXN-...`
    // So when reference is undefined, the check is skipped entirely
    const checkSection = INITIATE.match(/if \(reference !== undefined\) \{[\s\S]*?\}\s*\n\s*\n/);
    assert.ok(checkSection, 'must find the reference !== undefined guard block');
  });
});
