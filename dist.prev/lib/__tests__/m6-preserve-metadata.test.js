"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
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
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260928000000_preserve_merchant_metadata.sql'), 'utf-8');
const PROVIDER_OUTAGE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'lib/provider-outage.ts'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('M6-migration — preserve merchant metadata', () => {
    (0, node_test_1.it)('re-creates process_wallet_provider_callback', () => {
        strict_1.default.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.process_wallet_provider_callback/i);
    });
    (0, node_test_1.it)('does NOT use COALESCE(p_payload, ...) for metadata column (old overwrite)', () => {
        // The old code had: metadata = COALESCE(p_payload, '{}'::jsonb)
        // The new code should NOT assign COALESCE(p_payload, ...) to the metadata column.
        // Check the UPDATE statement specifically.
        const updateMatch = MIGRATION.match(/UPDATE public\.transactions[\s\S]*?WHERE id = v_tx\.id/);
        strict_1.default.ok(updateMatch, 'must find UPDATE transactions statement');
        strict_1.default.doesNotMatch(updateMatch[0], /metadata\s*=\s*COALESCE\(p_payload/);
    });
    (0, node_test_1.it)('builds a merged metadata structure with merchant_metadata and provider_payload', () => {
        strict_1.default.match(MIGRATION, /merchant_metadata/);
        strict_1.default.match(MIGRATION, /provider_payload/);
    });
    (0, node_test_1.it)('preserves the original merchant metadata (v_tx.metadata)', () => {
        strict_1.default.match(MIGRATION, /merchant_metadata.*v_tx\.metadata|v_tx\.metadata.*merchant_metadata/);
    });
    (0, node_test_1.it)('stores the provider payload under provider_payload', () => {
        strict_1.default.match(MIGRATION, /provider_payload.*COALESCE\(p_payload|COALESCE\(p_payload.*provider_payload/);
    });
    (0, node_test_1.it)('preserves all existing logic (wallet credit, refund, merchant ledger)', () => {
        strict_1.default.match(MIGRATION, /v_credit/);
        strict_1.default.match(MIGRATION, /v_refund/);
        strict_1.default.match(MIGRATION, /merchant_ledger_entries/);
        strict_1.default.match(MIGRATION, /FOR UPDATE/);
    });
    (0, node_test_1.it)('preserves idempotence (already_terminal check)', () => {
        strict_1.default.match(MIGRATION, /already_terminal/);
    });
});
// ── provider-outage.ts tests ────────────────────────────────
(0, node_test_1.describe)('M6-provider-outage — handles merged metadata structure', () => {
    (0, node_test_1.it)('checks provider_payload in the merged structure', () => {
        strict_1.default.match(PROVIDER_OUTAGE, /provider_payload/);
    });
    (0, node_test_1.it)('preserves backward compatibility with flat structure (pre-M6)', () => {
        // The function should still check the flat structure for pre-M6
        // transactions and manual reconciliation.
        strict_1.default.match(PROVIDER_OUTAGE, /metadata\['unipesa_result_code'\]/);
        strict_1.default.match(PROVIDER_OUTAGE, /metadata\['result'\]/);
        strict_1.default.match(PROVIDER_OUTAGE, /metadata\['reason'\]/);
    });
    (0, node_test_1.it)('checks provider_payload.unipesa_result_code', () => {
        strict_1.default.match(PROVIDER_OUTAGE, /pp\['unipesa_result_code'\]/);
    });
    (0, node_test_1.it)('checks provider_payload.result.code', () => {
        strict_1.default.match(PROVIDER_OUTAGE, /pp\['result'\]/);
    });
    (0, node_test_1.it)('checks provider_payload.reason', () => {
        strict_1.default.match(PROVIDER_OUTAGE, /pp\['reason'\]/);
    });
});
//# sourceMappingURL=m6-preserve-metadata.test.js.map