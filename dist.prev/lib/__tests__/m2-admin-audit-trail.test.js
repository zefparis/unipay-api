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
 * M2 remediation tests — admin audit trail on financial writes.
 *
 * Verifies that logAdminAction is called on every financial write in:
 *   - admin/kyc.ts (approve, reject)
 *   - admin/wallet-reconcile.ts (credit/refund)
 *   - admin/onchain-reconciliation.ts (resolve_usdt_withdrawal, resolve_wcglt_operation)
 *   - admin/treasury-crypto-receipts.ts (create, update, cancel, archive, restore, delete)
 */
const ROOT = node_path_1.default.resolve(__dirname, '../../..');
const SRC = node_path_1.default.resolve(ROOT, 'src');
function read(rel) {
    return node_fs_1.default.readFileSync(node_path_1.default.resolve(SRC, rel), 'utf-8');
}
const KYC = read('routes/admin/kyc.ts');
const RECONCILE = read('routes/admin/wallet-reconcile.ts');
const ONCHAIN = read('routes/admin/onchain-reconciliation.ts');
const TREASURY = read('routes/admin/treasury-crypto-receipts.ts');
const IMPORT_RE = /import\s+\{\s*logAdminAction\s*\}\s+from\s+'\.\.\/\.\.\/lib\/admin-action-log\.js';/;
// ── kyc.ts ───────────────────────────────────────────────────
(0, node_test_1.describe)('M2-kyc — audit trail on KYC writes', () => {
    (0, node_test_1.it)('imports logAdminAction', () => {
        strict_1.default.match(KYC, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
    });
    (0, node_test_1.it)('logs merchant.kyc_approve on approve route', () => {
        strict_1.default.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_approve'/);
        strict_1.default.match(KYC, /logAdminAction\([\s\S]*?'merchant'[\s\S]*?merchant_id/);
    });
    (0, node_test_1.it)('logs merchant.kyc_reject on reject route', () => {
        strict_1.default.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_reject'/);
    });
    (0, node_test_1.it)('approve log includes previous and new kyc_status', () => {
        strict_1.default.match(KYC, /previous_kyc_status/);
        strict_1.default.match(KYC, /new_kyc_status:\s*'approved'/);
    });
    (0, node_test_1.it)('reject log includes notes', () => {
        strict_1.default.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_reject'[\s\S]*?notes/);
    });
});
// ── wallet-reconcile.ts ──────────────────────────────────────
(0, node_test_1.describe)('M2-reconcile — audit trail on wallet reconcile', () => {
    (0, node_test_1.it)('imports logAdminAction', () => {
        strict_1.default.match(RECONCILE, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
    });
});
// ── onchain-reconciliation.ts ────────────────────────────────
(0, node_test_1.describe)('M2-onchain — audit trail on on-chain resolution', () => {
    (0, node_test_1.it)('imports logAdminAction', () => {
        strict_1.default.match(ONCHAIN, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
    });
    (0, node_test_1.it)('logs onchain.resolve_usdt_withdrawal on USDT resolution', () => {
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_usdt_withdrawal'/);
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'withdrawal_request'/);
    });
    (0, node_test_1.it)('logs onchain.resolve_wcglt_operation on WCGLT resolution', () => {
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_wcglt_operation'/);
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain_operation'/);
    });
    (0, node_test_1.it)('USDT log includes tx_hash, outcome, amount', () => {
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_usdt_withdrawal'[\s\S]*?tx_hash[\s\S]*?outcome[\s\S]*?amount/);
    });
    (0, node_test_1.it)('WCGLT log includes tx_hash, outcome, amount_onchain', () => {
        strict_1.default.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_wcglt_operation'[\s\S]*?tx_hash[\s\S]*?outcome[\s\S]*?amount_onchain/);
    });
});
// ── treasury-crypto-receipts.ts ──────────────────────────────
(0, node_test_1.describe)('M2-treasury — audit trail on treasury crypto receipts', () => {
    (0, node_test_1.it)('imports logAdminAction', () => {
        strict_1.default.match(TREASURY, IMPORT_RE);
    });
    (0, node_test_1.it)('logs treasury.receipt_create on create', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_create'/);
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury_crypto_receipt'/);
    });
    (0, node_test_1.it)('logs treasury.internal_regularization_create on internal regularization', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.internal_regularization_create'/);
    });
    (0, node_test_1.it)('logs treasury.receipt_update on patch', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_update'/);
    });
    (0, node_test_1.it)('logs treasury.receipt_cancel on cancel', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_cancel'/);
    });
    (0, node_test_1.it)('logs treasury.receipt_archive on archive', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_archive'/);
    });
    (0, node_test_1.it)('logs treasury.receipt_restore on restore', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_restore'/);
    });
    (0, node_test_1.it)('logs treasury.receipt_delete on hard delete', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_delete'/);
    });
    (0, node_test_1.it)('create log includes asset, network, expected_amount', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_create'[\s\S]*?asset[\s\S]*?network[\s\S]*?expected_amount/);
    });
    (0, node_test_1.it)('update log includes fields and previous/new status', () => {
        strict_1.default.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_update'[\s\S]*?previous_status[\s\S]*?new_status/);
    });
});
//# sourceMappingURL=m2-admin-audit-trail.test.js.map