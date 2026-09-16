import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M2 remediation tests — admin audit trail on financial writes.
 *
 * Verifies that logAdminAction is called on every financial write in:
 *   - admin/kyc.ts (approve, reject)
 *   - admin/wallet-reconcile.ts (credit/refund)
 *   - admin/onchain-reconciliation.ts (resolve_usdt_withdrawal, resolve_wcglt_operation)
 *   - admin/treasury-crypto-receipts.ts (create, update, cancel, archive, restore, delete)
 */

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.resolve(ROOT, 'src');

function read(rel: string): string {
  return fs.readFileSync(path.resolve(SRC, rel), 'utf-8');
}

const KYC = read('routes/admin/kyc.ts');
const RECONCILE = read('routes/admin/wallet-reconcile.ts');
const ONCHAIN = read('routes/admin/onchain-reconciliation.ts');
const TREASURY = read('routes/admin/treasury-crypto-receipts.ts');

const IMPORT_RE = /import\s+\{\s*logAdminAction\s*\}\s+from\s+'\.\.\/\.\.\/lib\/admin-action-log\.js';/;

// ── kyc.ts ───────────────────────────────────────────────────

describe('M2-kyc — audit trail on KYC writes', () => {
  it('imports logAdminAction', () => {
    assert.match(KYC, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
  });

  it('logs merchant.kyc_approve on approve route', () => {
    assert.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_approve'/);
    assert.match(KYC, /logAdminAction\([\s\S]*?'merchant'[\s\S]*?merchant_id/);
  });

  it('logs merchant.kyc_reject on reject route', () => {
    assert.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_reject'/);
  });

  it('approve log includes previous and new kyc_status', () => {
    assert.match(KYC, /previous_kyc_status/);
    assert.match(KYC, /new_kyc_status:\s*'approved'/);
  });

  it('reject log includes notes', () => {
    assert.match(KYC, /logAdminAction\([\s\S]*?'merchant\.kyc_reject'[\s\S]*?notes/);
  });
});

// ── wallet-reconcile.ts ──────────────────────────────────────

describe('M2-reconcile — audit trail on wallet reconcile', () => {
  it('imports logAdminAction', () => {
    assert.match(RECONCILE, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
  });
});

// ── onchain-reconciliation.ts ────────────────────────────────

describe('M2-onchain — audit trail on on-chain resolution', () => {
  it('imports logAdminAction', () => {
    assert.match(ONCHAIN, /import \{ logAdminAction \} from '\.\.\/\.\.\/lib\/admin-action-log\.js';/);
  });

  it('logs onchain.resolve_usdt_withdrawal on USDT resolution', () => {
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_usdt_withdrawal'/);
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'withdrawal_request'/);
  });

  it('logs onchain.resolve_wcglt_operation on WCGLT resolution', () => {
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_wcglt_operation'/);
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain_operation'/);
  });

  it('USDT log includes tx_hash, outcome, amount', () => {
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_usdt_withdrawal'[\s\S]*?tx_hash[\s\S]*?outcome[\s\S]*?amount/);
  });

  it('WCGLT log includes tx_hash, outcome, amount_onchain', () => {
    assert.match(ONCHAIN, /logAdminAction\([\s\S]*?'onchain\.resolve_wcglt_operation'[\s\S]*?tx_hash[\s\S]*?outcome[\s\S]*?amount_onchain/);
  });
});

// ── treasury-crypto-receipts.ts ──────────────────────────────

describe('M2-treasury — audit trail on treasury crypto receipts', () => {
  it('imports logAdminAction', () => {
    assert.match(TREASURY, IMPORT_RE);
  });

  it('logs treasury.receipt_create on create', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_create'/);
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury_crypto_receipt'/);
  });

  it('logs treasury.internal_regularization_create on internal regularization', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.internal_regularization_create'/);
  });

  it('logs treasury.receipt_update on patch', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_update'/);
  });

  it('logs treasury.receipt_cancel on cancel', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_cancel'/);
  });

  it('logs treasury.receipt_archive on archive', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_archive'/);
  });

  it('logs treasury.receipt_restore on restore', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_restore'/);
  });

  it('logs treasury.receipt_delete on hard delete', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_delete'/);
  });

  it('create log includes asset, network, expected_amount', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_create'[\s\S]*?asset[\s\S]*?network[\s\S]*?expected_amount/);
  });

  it('update log includes fields and previous/new status', () => {
    assert.match(TREASURY, /logAdminAction\([\s\S]*?'treasury\.receipt_update'[\s\S]*?previous_status[\s\S]*?new_status/);
  });
});
