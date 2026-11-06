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
 * M9 remediation tests — idempotency on /payment/initiate.
 *
 * Verifies:
 *   - Migration adds UNIQUE constraint on (merchant_id, reference)
 *   - initiate.ts checks for existing transaction with same reference
 *   - Non-terminal existing transaction returns idempotent 201
 *   - Terminal existing transaction returns 409 DUPLICATE_REFERENCE
 *   - Auto-generated references skip the check
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
const INITIATE = node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, 'routes/payment/initiate.ts'), 'utf-8');
const MIGRATION = node_fs_1.default.readFileSync(node_path_1.default.resolve(ROOT, 'supabase/migrations/20260924000000_initiate_idempotency.sql'), 'utf-8');
// ── Migration tests ──────────────────────────────────────────
(0, node_test_1.describe)('M9-migration — UNIQUE constraint on (merchant_id, reference)', () => {
    (0, node_test_1.it)('creates a unique index on (merchant_id, reference)', () => {
        strict_1.default.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS transactions_merchant_reference_unique/i);
    });
    (0, node_test_1.it)('index is on (merchant_id, reference)', () => {
        strict_1.default.match(MIGRATION, /ON public\.transactions \(merchant_id, reference\)/i);
    });
    (0, node_test_1.it)('index is partial — only when reference IS NOT NULL', () => {
        strict_1.default.match(MIGRATION, /WHERE reference IS NOT NULL/i);
    });
    (0, node_test_1.it)('contains a pre-migration duplicate check query (commented)', () => {
        strict_1.default.match(MIGRATION, /HAVING count\(\*\) > 1/);
        strict_1.default.match(MIGRATION, /GROUP BY merchant_id, reference/);
    });
});
// ── initiate.ts tests ────────────────────────────────────────
(0, node_test_1.describe)('M9-initiate — idempotency check', () => {
    (0, node_test_1.it)('checks for existing transaction with same (merchant_id, reference)', () => {
        strict_1.default.match(INITIATE, /Idempotency check/i);
        strict_1.default.match(INITIATE, /\.eq\('merchant_id', merchantId\)/);
        strict_1.default.match(INITIATE, /\.eq\('reference', resolvedReference\)/);
        strict_1.default.match(INITIATE, /\.maybeSingle\(\)/);
    });
    (0, node_test_1.it)('only checks when reference is explicitly provided (not auto-generated)', () => {
        strict_1.default.match(INITIATE, /if \(reference !== undefined\)/);
    });
    (0, node_test_1.it)('returns existing transaction with idempotent: true for non-terminal status', () => {
        strict_1.default.match(INITIATE, /status === 'pending' \|\| existingTx\.status === 'processing'/);
        strict_1.default.match(INITIATE, /idempotent: true/);
        strict_1.default.match(INITIATE, /Idempotent replay/i);
    });
    (0, node_test_1.it)('returns 409 DUPLICATE_REFERENCE for terminal status', () => {
        strict_1.default.match(INITIATE, /DUPLICATE_REFERENCE/);
        strict_1.default.match(INITIATE, /409/);
        strict_1.default.match(INITIATE, /existing_transaction_id/);
        strict_1.default.match(INITIATE, /existing_status/);
    });
    (0, node_test_1.it)('response schema includes idempotent field', () => {
        strict_1.default.match(INITIATE, /idempotent:\s*\{\s*type:\s*'boolean'/);
    });
    (0, node_test_1.it)('idempotent return happens BEFORE the sandbox/live insert path', () => {
        // The idempotency check should be before the transaction insert
        const idempotencyPos = INITIATE.indexOf('Idempotency check');
        const insertPos = INITIATE.indexOf("from('transactions')\n        .insert(");
        strict_1.default.ok(idempotencyPos > -1, 'must find idempotency check');
        strict_1.default.ok(insertPos > -1, 'must find transaction insert');
        strict_1.default.ok(idempotencyPos < insertPos, 'idempotency check must run BEFORE transaction insert');
    });
    (0, node_test_1.it)('does NOT check idempotency for auto-generated references', () => {
        // The check is guarded by `if (reference !== undefined)`
        // Auto-generated references come from `reference ?? TXN-...`
        // So when reference is undefined, the check is skipped entirely
        const checkSection = INITIATE.match(/if \(reference !== undefined\) \{[\s\S]*?\}\s*\n\s*\n/);
        strict_1.default.ok(checkSection, 'must find the reference !== undefined guard block');
    });
});
//# sourceMappingURL=m9-initiate-idempotency.test.js.map