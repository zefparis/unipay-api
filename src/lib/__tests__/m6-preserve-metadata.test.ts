import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M6 remediation tests — preserve merchant metadata on provider callback.
 *
 * The original process_wallet_provider_callback overwrote the merchant's
 * metadata with the provider's payload:
 *   metadata = COALESCE(p_payload, '{}'::jsonb)
 *
 * Fix: merge the two with distinct keys:
 *   - merchant_metadata: the original metadata from initiation
 *   - provider_payload: the raw payload from the provider callback
 *
 * Also verifies that provider-outage.ts handles both the new merged
 * structure (provider_payload) and the old flat structure (pre-M6
 * transactions or manual reconciliation).
 */

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

const MIGRATION = fs.readFileSync(
  path.resolve(ROOT, 'supabase/migrations/20260928000000_preserve_merchant_metadata.sql'),
  'utf-8',
);
const PROVIDER_OUTAGE = fs.readFileSync(path.resolve(SRC, 'lib/provider-outage.ts'), 'utf-8');

// ── Migration tests ──────────────────────────────────────────

describe('M6-migration — preserve merchant metadata', () => {
  it('re-creates process_wallet_provider_callback', () => {
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.process_wallet_provider_callback/i);
  });

  it('does NOT use COALESCE(p_payload, ...) for metadata column (old overwrite)', () => {
    // The old code had: metadata = COALESCE(p_payload, '{}'::jsonb)
    // The new code should NOT assign COALESCE(p_payload, ...) to the metadata column.
    // Check the UPDATE statement specifically.
    const updateMatch = MIGRATION.match(/UPDATE public\.transactions[\s\S]*?WHERE id = v_tx\.id/);
    assert.ok(updateMatch, 'must find UPDATE transactions statement');
    assert.doesNotMatch(updateMatch[0], /metadata\s*=\s*COALESCE\(p_payload/);
  });

  it('builds a merged metadata structure with merchant_metadata and provider_payload', () => {
    assert.match(MIGRATION, /merchant_metadata/);
    assert.match(MIGRATION, /provider_payload/);
  });

  it('preserves the original merchant metadata (v_tx.metadata)', () => {
    assert.match(MIGRATION, /merchant_metadata.*v_tx\.metadata|v_tx\.metadata.*merchant_metadata/);
  });

  it('stores the provider payload under provider_payload', () => {
    assert.match(MIGRATION, /provider_payload.*COALESCE\(p_payload|COALESCE\(p_payload.*provider_payload/);
  });

  it('preserves all existing logic (wallet credit, refund, merchant ledger)', () => {
    assert.match(MIGRATION, /v_credit/);
    assert.match(MIGRATION, /v_refund/);
    assert.match(MIGRATION, /merchant_ledger_entries/);
    assert.match(MIGRATION, /FOR UPDATE/);
  });

  it('preserves idempotence (already_terminal check)', () => {
    assert.match(MIGRATION, /already_terminal/);
  });
});

// ── provider-outage.ts tests ────────────────────────────────

describe('M6-provider-outage — handles merged metadata structure', () => {
  it('checks provider_payload in the merged structure', () => {
    assert.match(PROVIDER_OUTAGE, /provider_payload/);
  });

  it('preserves backward compatibility with flat structure (pre-M6)', () => {
    // The function should still check the flat structure for pre-M6
    // transactions and manual reconciliation.
    assert.match(PROVIDER_OUTAGE, /metadata\['unipesa_result_code'\]/);
    assert.match(PROVIDER_OUTAGE, /metadata\['result'\]/);
    assert.match(PROVIDER_OUTAGE, /metadata\['reason'\]/);
  });

  it('checks provider_payload.unipesa_result_code', () => {
    assert.match(PROVIDER_OUTAGE, /pp\['unipesa_result_code'\]/);
  });

  it('checks provider_payload.result.code', () => {
    assert.match(PROVIDER_OUTAGE, /pp\['result'\]/);
  });

  it('checks provider_payload.reason', () => {
    assert.match(PROVIDER_OUTAGE, /pp\['reason'\]/);
  });
});
