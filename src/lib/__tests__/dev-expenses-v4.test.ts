/**
 * Tests for dev-expenses-v4 service — state machine, amounts, transitions
 * Run with: node --import tsx/esm --test src/services/__tests__/dev-expenses-v4.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  getAllowedTransitions,
  getExpectedSettlementAmount,
  getRemainingAmount,
  validateTransition,
  type DevExpenseV4,
  type DevExpenseStatusV4,
} from '../../services/dev-expenses-v4';

/* ── Helpers ──────────────────────────────────────────────── */

function makeExpense(overrides: Partial<DevExpenseV4> = {}): DevExpenseV4 {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: null,
    description: null,
    category: 'Test',
    creditor_id: null,
    project_code: 'unipay-congo',
    project_ref: null,
    quote_id: null,
    billing_month: '2026-07-01',
    invoice_number: null,
    invoice_date: null,
    due_date: null,
    incurred_by_entity_id: null,
    initially_paid_by_entity_id: null,
    covered_by_entity_id: null,
    reimbursement_recipient_entity_id: null,
    amount_usd: 1000,
    invoice_amount: 1000,
    invoice_currency: 'USD',
    requested_amount: 1000,
    approved_amount: null,
    settled_amount: 0,
    initial_payment_status: null,
    initial_payment_method: null,
    status_v4: 'draft',
    status: 'pending',
    submitted_at: null,
    review_started_at: null,
    approved_at: null,
    payment_scheduled_at: null,
    completed_at: null,
    cancelled_at: null,
    rejection_reason: null,
    dispute_reason: null,
    internal_notes_v4: null,
    migration_review_required: false,
    migration_notes: null,
    legacy_status: null,
    legacy_funded_by: null,
    legacy_paid_by: null,
    archived: false,
    archived_at: null,
    paid_at: null,
    created_at: '2026-07-18T00:00:00Z',
    updated_at: '2026-07-18T00:00:00Z',
    ...overrides,
  };
}

const ENTITY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ENTITY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/* ── State machine: allowed transitions ───────────────────── */

describe('State machine: canTransition', () => {
  it('draft → submitted is allowed', () => {
    assert.equal(canTransition('draft', 'submitted'), true);
  });

  it('submitted → under_review is allowed', () => {
    assert.equal(canTransition('submitted', 'under_review'), true);
  });

  it('under_review → approved is allowed', () => {
    assert.equal(canTransition('under_review', 'approved'), true);
  });

  it('under_review → partially_approved is allowed', () => {
    assert.equal(canTransition('under_review', 'partially_approved'), true);
  });

  it('under_review → rejected is allowed', () => {
    assert.equal(canTransition('under_review', 'rejected'), true);
  });

  it('approved → payment_scheduled is allowed', () => {
    assert.equal(canTransition('approved', 'payment_scheduled'), true);
  });

  it('partially_approved → payment_scheduled is allowed', () => {
    assert.equal(canTransition('partially_approved', 'payment_scheduled'), true);
  });

  it('payment_scheduled → partially_paid is allowed', () => {
    assert.equal(canTransition('payment_scheduled', 'partially_paid'), true);
  });

  it('payment_scheduled → completed is allowed', () => {
    assert.equal(canTransition('payment_scheduled', 'completed'), true);
  });

  it('partially_paid → completed is allowed', () => {
    assert.equal(canTransition('partially_paid', 'completed'), true);
  });

  it('completed → archived is allowed', () => {
    assert.equal(canTransition('completed', 'archived'), true);
  });

  it('approved → disputed is allowed', () => {
    assert.equal(canTransition('approved', 'disputed'), true);
  });

  it('partially_approved → disputed is allowed', () => {
    assert.equal(canTransition('partially_approved', 'disputed'), true);
  });

  it('payment_scheduled → approved (back) is allowed', () => {
    assert.equal(canTransition('payment_scheduled', 'approved'), true);
  });

  it('partially_paid → payment_scheduled (back) is allowed', () => {
    assert.equal(canTransition('partially_paid', 'payment_scheduled'), true);
  });

  it('rejected → draft (back) is allowed', () => {
    assert.equal(canTransition('rejected', 'draft'), true);
  });

  it('disputed → under_review (back) is allowed', () => {
    assert.equal(canTransition('disputed', 'under_review'), true);
  });

  it('draft → completed is NOT allowed', () => {
    assert.equal(canTransition('draft', 'completed'), false);
  });

  it('draft → approved is NOT allowed', () => {
    assert.equal(canTransition('draft', 'approved'), false);
  });

  it('archived → draft is NOT allowed', () => {
    assert.equal(canTransition('archived', 'draft'), false);
  });

  it('archived has no allowed transitions', () => {
    assert.deepEqual(getAllowedTransitions('archived'), []);
  });
});

/* ── Amount calculations ──────────────────────────────────── */

describe('Amount calculations', () => {
  it('getExpectedSettlementAmount uses approved_amount first', () => {
    const e = makeExpense({ approved_amount: 800, requested_amount: 1000, invoice_amount: 1200 });
    assert.equal(getExpectedSettlementAmount(e), 800);
  });

  it('getExpectedSettlementAmount falls back to requested_amount', () => {
    const e = makeExpense({ approved_amount: null, requested_amount: 1000, invoice_amount: 1200 });
    assert.equal(getExpectedSettlementAmount(e), 1000);
  });

  it('getExpectedSettlementAmount falls back to invoice_amount', () => {
    const e = makeExpense({ approved_amount: null, requested_amount: null, invoice_amount: 1200 });
    assert.equal(getExpectedSettlementAmount(e), 1200);
  });

  it('getExpectedSettlementAmount falls back to amount_usd', () => {
    const e = makeExpense({ approved_amount: null, requested_amount: null, invoice_amount: null, amount_usd: 500 });
    assert.equal(getExpectedSettlementAmount(e), 500);
  });

  it('getRemainingAmount = expected - settled', () => {
    const e = makeExpense({ approved_amount: 800, settled_amount: 300 });
    assert.equal(getRemainingAmount(e), 500);
  });

  it('getRemainingAmount is never negative', () => {
    const e = makeExpense({ approved_amount: 500, settled_amount: 800 });
    assert.equal(getRemainingAmount(e), 0);
  });
});

/* ── Transition validation ────────────────────────────────── */

describe('Transition validation', () => {
  it('draft → submitted requires title', () => {
    const e = makeExpense({ status_v4: 'draft', title: null });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /title/i);
  });

  it('draft → submitted requires invoice_amount > 0', () => {
    const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 0 });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /invoice.*amount/i);
  });

  it('draft → submitted requires incurred_by_entity_id', () => {
    const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 1000, incurred_by_entity_id: null });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /incurred/i);
  });

  it('draft → submitted requires covered_by_entity_id', () => {
    const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 1000, incurred_by_entity_id: ENTITY_A, covered_by_entity_id: null });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /covered/i);
  });

  it('draft → submitted passes with all required fields', () => {
    const e = makeExpense({
      status_v4: 'draft',
      title: 'Test',
      invoice_amount: 1000,
      incurred_by_entity_id: ENTITY_A,
      covered_by_entity_id: ENTITY_B,
    });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, true);
  });

  it('under_review → approved requires approved_amount > 0', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'approved', approved_amount: 0 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /approved_amount/i);
  });

  it('under_review → approved passes with approved_amount = requested', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'approved', approved_amount: 1000, approved_equals_requested: true });
    assert.equal(result.ok, true);
  });

  it('under_review → approved rejects approved > requested without flag', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'approved', approved_amount: 1200 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /exceed/i);
  });

  it('under_review → partially_approved requires approved < requested', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'partially_approved', approved_amount: 1000, notes: 'Test' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /partial/i);
  });

  it('under_review → partially_approved requires notes', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'partially_approved', approved_amount: 800 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /notes/i);
  });

  it('under_review → partially_approved passes with notes and approved < requested', () => {
    const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
    const result = validateTransition(e, { to: 'partially_approved', approved_amount: 800, notes: 'Discount applied' });
    assert.equal(result.ok, true);
  });

  it('under_review → rejected requires reason', () => {
    const e = makeExpense({ status_v4: 'under_review' });
    const result = validateTransition(e, { to: 'rejected' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /rejection/i);
  });

  it('under_review → rejected passes with reason', () => {
    const e = makeExpense({ status_v4: 'under_review' });
    const result = validateTransition(e, { to: 'rejected', reason: 'Invalid invoice' });
    assert.equal(result.ok, true);
  });

  it('approved → disputed requires reason', () => {
    const e = makeExpense({ status_v4: 'approved', approved_amount: 1000 });
    const result = validateTransition(e, { to: 'disputed' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /dispute/i);
  });

  it('approved → disputed passes with reason', () => {
    const e = makeExpense({ status_v4: 'approved', approved_amount: 1000 });
    const result = validateTransition(e, { to: 'disputed', reason: 'Amount incorrect' });
    assert.equal(result.ok, true);
  });

  it('same status transition is rejected', () => {
    const e = makeExpense({ status_v4: 'draft' });
    const result = validateTransition(e, { to: 'draft' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /already/i);
  });

  it('disallowed transition is rejected', () => {
    const e = makeExpense({ status_v4: 'draft' });
    const result = validateTransition(e, { to: 'completed' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /not allowed/i);
  });

  it('null status_v4 is rejected', () => {
    const e = makeExpense({ status_v4: null });
    const result = validateTransition(e, { to: 'submitted' });
    assert.equal(result.ok, false);
    assert.match(result.error!, /legacy/i);
  });
});
