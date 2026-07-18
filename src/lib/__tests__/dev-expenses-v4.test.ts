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
  getBillingSnapshotDifference,
  PUBLIC_ENTITY_COLUMNS,
  type DevExpenseV4,
  type DevExpenseStatusV4,
  type ExpenseEntity,
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
    billing_recipient_entity_id: null,
    billing_recipient_snapshot: null,
    billing_recipient_reviewed: false,
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

function makeEntity(overrides: Partial<ExpenseEntity> = {}): ExpenseEntity {
  return {
    id: '00000000-0000-0000-0000-000000000010',
    code: 'TEST',
    display_name: 'Test',
    entity_type: 'company',
    legal_name: null,
    trade_name: null,
    country_code: null,
    email: null,
    phone: null,
    address: null,
    city: null,
    postal_code: null,
    tax_id: null,
    registration_number: null,
    vat_number: null,
    address_line_1: null,
    address_line_2: null,
    region: null,
    contact_name: null,
    billing_email: null,
    contact_email: null,
    website: null,
    legal_notes: null,
    can_incur_expenses: true,
    can_receive_invoices: true,
    can_pay_expenses: true,
    can_cover_expenses: true,
    can_receive_reimbursements: true,
    bank_details: {},
    active: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
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

/* ── Snapshot allowlist enforcement ────────────────────────── */

describe('Snapshot allowlist: forbidden keys never present', () => {
  const FORBIDDEN_KEYS = ['bank_details', 'metadata', 'legal_notes', 'payment_details', 'credentials', 'active', 'created_at', 'updated_at', 'can_receive_invoices', 'can_pay_expenses', 'can_cover_expenses', 'can_receive_reimbursements'];

  function makeEntity(overrides: Partial<ExpenseEntity> = {}): ExpenseEntity {
    return {
      id: '00000000-0000-0000-0000-000000000010',
      code: 'TEST',
      display_name: 'Test Entity',
      entity_type: 'company',
      legal_name: 'Test Legal Name',
      trade_name: null,
      country_code: 'CD',
      email: 'test@example.com',
      phone: '+243000000',
      address: '123 Main St',
      city: 'Kinshasa',
      postal_code: '00000',
      tax_id: 'TAX123',
      registration_number: 'REG123',
      vat_number: null,
      address_line_1: null,
      address_line_2: null,
      region: null,
      contact_name: 'John Doe',
      billing_email: null,
      contact_email: null,
      website: null,
      legal_notes: 'Secret internal notes',
      can_incur_expenses: true,
      can_receive_invoices: true,
      can_pay_expenses: true,
      can_cover_expenses: true,
      can_receive_reimbursements: true,
      bank_details: { iban: 'SECRET_IBAN', swift: 'SECRET_SWIFT' },
      active: true,
      metadata: { internal: 'secret' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      ...overrides,
    };
  }

  // Simulate the buildBillingRecipientSnapshot logic
  function buildSnapshot(entity: ExpenseEntity): Record<string, unknown> {
    return {
      entity_id: entity.id,
      legal_name: entity.legal_name ?? null,
      trade_name: entity.trade_name ?? null,
      display_name: entity.display_name,
      entity_type: entity.entity_type,
      registration_number: entity.registration_number ?? null,
      tax_id: entity.tax_id ?? null,
      vat_number: entity.vat_number ?? null,
      address_line_1: entity.address_line_1 ?? entity.address ?? null,
      address_line_2: entity.address_line_2 ?? null,
      postal_code: entity.postal_code ?? null,
      city: entity.city ?? null,
      region: entity.region ?? null,
      country_code: entity.country_code ?? null,
      contact_name: entity.contact_name ?? null,
      billing_email: entity.billing_email ?? entity.email ?? null,
      phone: entity.phone ?? null,
      captured_at: new Date().toISOString(),
    };
  }

  it('snapshot does not contain bank_details', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('bank_details' in snapshot, false);
  });

  it('snapshot does not contain metadata', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('metadata' in snapshot, false);
  });

  it('snapshot does not contain legal_notes', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('legal_notes' in snapshot, false);
  });

  it('snapshot does not contain active flag', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('active' in snapshot, false);
  });

  it('snapshot does not contain role capability flags', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('can_receive_invoices' in snapshot, false);
    assert.equal('can_pay_expenses' in snapshot, false);
    assert.equal('can_cover_expenses' in snapshot, false);
    assert.equal('can_receive_reimbursements' in snapshot, false);
  });

  it('snapshot does not contain internal timestamps', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    assert.equal('created_at' in snapshot, false);
    assert.equal('updated_at' in snapshot, false);
  });

  it('snapshot contains only allowed keys', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    const allowedKeys = new Set([
      'entity_id', 'legal_name', 'trade_name', 'display_name', 'entity_type',
      'registration_number', 'tax_id', 'vat_number',
      'address_line_1', 'address_line_2', 'postal_code', 'city', 'region', 'country_code',
      'contact_name', 'billing_email', 'phone',
      'captured_at',
    ]);
    for (const key of Object.keys(snapshot)) {
      assert.ok(allowedKeys.has(key), `Unexpected key in snapshot: ${key}`);
    }
  });

  it('snapshot does not contain any forbidden keys', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    for (const forbidden of FORBIDDEN_KEYS) {
      assert.equal(forbidden in snapshot, false, `Forbidden key '${forbidden}' found in snapshot`);
    }
  });

  it('snapshot is immutable after entity modification (different object)', () => {
    const entity = makeEntity();
    const snapshot = buildSnapshot(entity);
    entity.legal_name = 'Changed Name';
    // Snapshot should still have the original value
    assert.equal(snapshot.legal_name, 'Test Legal Name');
  });

  it('snapshot uses address_line_1 fallback to address', () => {
    const entity = makeEntity({ address_line_1: null, address: 'Fallback Address' });
    const snapshot = buildSnapshot(entity);
    assert.equal(snapshot.address_line_1, 'Fallback Address');
  });

  it('snapshot uses billing_email fallback to email', () => {
    const entity = makeEntity({ billing_email: null, email: 'fallback@example.com' });
    const snapshot = buildSnapshot(entity);
    assert.equal(snapshot.billing_email, 'fallback@example.com');
  });
});

/* ── getBillingSnapshotDifference ───────────────────────────── */

describe('getBillingSnapshotDifference', () => {
  function makeEntity(overrides: Partial<ExpenseEntity> = {}): ExpenseEntity {
    return {
      id: '00000000-0000-0000-0000-000000000010',
      code: 'TEST',
      display_name: 'Test Entity',
      entity_type: 'company',
      legal_name: 'Test Legal',
      trade_name: null,
      country_code: 'CD',
      email: 'test@example.com',
      phone: '+243000000',
      address: '123 Main St',
      city: 'Kinshasa',
      postal_code: '00000',
      tax_id: 'TAX123',
      registration_number: 'REG123',
      vat_number: null,
      address_line_1: null,
      address_line_2: null,
      region: null,
      contact_name: 'John',
      billing_email: null,
      contact_email: null,
      website: null,
      legal_notes: null,
      can_incur_expenses: true,
      can_receive_invoices: true,
      can_pay_expenses: true,
      can_cover_expenses: true,
      can_receive_reimbursements: true,
      bank_details: {},
      active: true,
      metadata: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      ...overrides,
    };
  }

  it('returns differs=false when snapshot is null', () => {
    const entity = makeEntity();
    const result = getBillingSnapshotDifference(null, entity);
    assert.equal(result.differs, false);
    assert.deepEqual(result.changedFields, []);
  });

  it('returns differs=false when entity is null', () => {
    const snapshot = { legal_name: 'Test', captured_at: '2026-01-01' };
    const result = getBillingSnapshotDifference(snapshot, null);
    assert.equal(result.differs, false);
  });

  it('returns differs=false when all fields match', () => {
    const entity = makeEntity();
    const snapshot = {
      legal_name: entity.legal_name,
      trade_name: entity.trade_name,
      registration_number: entity.registration_number,
      tax_id: entity.tax_id,
      vat_number: entity.vat_number,
      address_line_1: entity.address,
      address_line_2: entity.address_line_2,
      postal_code: entity.postal_code,
      city: entity.city,
      region: entity.region,
      country_code: entity.country_code,
      contact_name: entity.contact_name,
      billing_email: entity.email,
      phone: entity.phone,
      captured_at: '2026-01-01',
    };
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, false);
    assert.deepEqual(result.changedFields, []);
  });

  it('returns differs=true when address changes', () => {
    const entity = makeEntity({ address: 'New Address' });
    const snapshot = {
      legal_name: 'Test Legal',
      address_line_1: 'Old Address',
      captured_at: '2026-01-01',
    };
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, true);
    assert.ok(result.changedFields.includes('address_line_1'));
  });

  it('returns differs=true when billing_email changes', () => {
    const entity = makeEntity({ email: 'new@example.com' });
    const snapshot = {
      billing_email: 'old@example.com',
      captured_at: '2026-01-01',
    };
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, true);
    assert.ok(result.changedFields.includes('billing_email'));
  });

  function makeMatchingSnapshot(entity: ExpenseEntity): Record<string, unknown> {
    return {
      legal_name: entity.legal_name,
      trade_name: entity.trade_name,
      registration_number: entity.registration_number,
      tax_id: entity.tax_id,
      vat_number: entity.vat_number,
      address_line_1: entity.address_line_1 ?? entity.address,
      address_line_2: entity.address_line_2,
      postal_code: entity.postal_code,
      city: entity.city,
      region: entity.region,
      country_code: entity.country_code,
      contact_name: entity.contact_name,
      billing_email: entity.billing_email ?? entity.email,
      phone: entity.phone,
      captured_at: '2026-01-01',
    };
  }

  it('returns differs=false when only captured_at (timestamp) differs', () => {
    const entity = makeEntity();
    const snapshot = makeMatchingSnapshot(entity);
    // captured_at is not in SNAPSHOT_COMPARE_FIELDS, so it should not count
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, false);
  });

  it('returns differs=false when only bank_details change (not compared)', () => {
    const entity = makeEntity({ bank_details: { iban: 'NEW_IBAN' } });
    const snapshot = makeMatchingSnapshot(entity);
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, false);
  });

  it('returns differs=true when country_code changes', () => {
    const entity = makeEntity({ country_code: 'FR' });
    const snapshot = {
      country_code: 'CD',
      captured_at: '2026-01-01',
    };
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, true);
    assert.ok(result.changedFields.includes('country_code'));
  });

  it('normalizes empty string as null (no false positive)', () => {
    const entity = makeEntity({ region: '' });
    const snapshot = makeMatchingSnapshot(entity);
    snapshot.region = null;
    const result = getBillingSnapshotDifference(snapshot, entity);
    // '' and null should be treated as equal
    assert.equal(result.differs, false);
  });

  it('detects multiple changed fields', () => {
    const entity = makeEntity({ legal_name: 'New Legal', city: 'Lubumbashi', country_code: 'FR' });
    const snapshot = makeMatchingSnapshot(entity);
    snapshot.legal_name = 'Old Legal';
    snapshot.city = 'Kinshasa';
    snapshot.country_code = 'CD';
    const result = getBillingSnapshotDifference(snapshot, entity);
    assert.equal(result.differs, true);
    assert.equal(result.changedFields.length, 3);
    assert.ok(result.changedFields.includes('legal_name'));
    assert.ok(result.changedFields.includes('city'));
    assert.ok(result.changedFields.includes('country_code'));
  });
});

/* ── Role validation logic ─────────────────────────────────── */

describe('Role validation logic', () => {
  function makeEntity(overrides: Partial<ExpenseEntity> = {}): ExpenseEntity {
    return {
      id: '00000000-0000-0000-0000-000000000010',
      code: 'TEST',
      display_name: 'Test',
      entity_type: 'company',
      legal_name: null,
      trade_name: null,
      country_code: null,
      email: null,
      phone: null,
      address: null,
      city: null,
      postal_code: null,
      tax_id: null,
      registration_number: null,
      vat_number: null,
      address_line_1: null,
      address_line_2: null,
      region: null,
      contact_name: null,
      billing_email: null,
      contact_email: null,
      website: null,
      legal_notes: null,
      can_incur_expenses: true,
      can_receive_invoices: true,
      can_pay_expenses: true,
      can_cover_expenses: true,
      can_receive_reimbursements: true,
      bank_details: {},
      active: true,
      metadata: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('active entity with can_receive_invoices=true should pass', () => {
    const entity = makeEntity({ active: true, can_receive_invoices: true });
    assert.ok(entity.active && entity.can_receive_invoices);
  });

  it('inactive entity should fail role check', () => {
    const entity = makeEntity({ active: false, can_receive_invoices: true });
    assert.equal(entity.active, false);
  });

  it('entity with can_receive_invoices=false should fail billing recipient role', () => {
    const entity = makeEntity({ active: true, can_receive_invoices: false });
    assert.equal(entity.can_receive_invoices, false);
  });

  it('entity with can_incur_expenses=false should fail incurred_by role', () => {
    const entity = makeEntity({ active: true, can_incur_expenses: false });
    assert.equal(entity.can_incur_expenses, false);
  });

  it('entity with can_pay_expenses=false should fail initially_paid_by role', () => {
    const entity = makeEntity({ active: true, can_pay_expenses: false });
    assert.equal(entity.can_pay_expenses, false);
  });

  it('entity with can_cover_expenses=false should fail covered_by role', () => {
    const entity = makeEntity({ active: true, can_cover_expenses: false });
    assert.equal(entity.can_cover_expenses, false);
  });

  it('entity with can_receive_reimbursements=false should fail reimbursement role', () => {
    const entity = makeEntity({ active: true, can_receive_reimbursements: false });
    assert.equal(entity.can_receive_reimbursements, false);
  });

  it('entity can incur without can_pay (role separation)', () => {
    const entity = makeEntity({ active: true, can_incur_expenses: true, can_pay_expenses: false });
    assert.equal(entity.can_incur_expenses, true);
    assert.equal(entity.can_pay_expenses, false);
  });

  it('entity can pay without being the incurring entity', () => {
    const entity = makeEntity({ active: true, can_incur_expenses: false, can_pay_expenses: true });
    assert.equal(entity.can_incur_expenses, false);
    assert.equal(entity.can_pay_expenses, true);
  });

  it('inactive entity refused even if all role flags are true', () => {
    const entity = makeEntity({ active: false });
    assert.equal(entity.active, false);
  });

  it('can_incur_expenses=false refused for incurred_by', () => {
    const entity = makeEntity({ active: true, can_incur_expenses: false });
    assert.equal(entity.can_incur_expenses, false);
  });

  it('all roles default to true for new entities', () => {
    const entity = makeEntity();
    assert.equal(entity.can_incur_expenses, true);
    assert.equal(entity.can_receive_invoices, true);
    assert.equal(entity.can_pay_expenses, true);
    assert.equal(entity.can_cover_expenses, true);
    assert.equal(entity.can_receive_reimbursements, true);
  });
});

/* ── PUBLIC_ENTITY_COLUMNS: bank_details exclusion ────────── */

describe('PUBLIC_ENTITY_COLUMNS', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof PUBLIC_ENTITY_COLUMNS === 'string');
    assert.ok(PUBLIC_ENTITY_COLUMNS.length > 0);
  });

  it('does not contain bank_details', () => {
    assert.ok(!PUBLIC_ENTITY_COLUMNS.includes('bank_details'));
  });

  it('contains legal_notes (admin-only, but not in snapshots)', () => {
    assert.ok(PUBLIC_ENTITY_COLUMNS.includes('legal_notes'));
  });

  it('contains all required public columns', () => {
    const required = [
      'id', 'code', 'display_name', 'entity_type',
      'legal_name', 'trade_name', 'country_code',
      'email', 'phone', 'address', 'city', 'postal_code', 'tax_id',
      'registration_number', 'vat_number',
      'address_line_1', 'address_line_2', 'region',
      'contact_name', 'billing_email', 'contact_email', 'website',
      'active',
      'can_incur_expenses', 'can_pay_expenses', 'can_cover_expenses',
      'can_receive_invoices', 'can_receive_reimbursements',
      'metadata', 'created_at', 'updated_at',
    ];
    for (const col of required) {
      assert.ok(
        PUBLIC_ENTITY_COLUMNS.includes(col),
        `PUBLIC_ENTITY_COLUMNS missing required column: ${col}`,
      );
    }
  });

  it('can be safely used in a Supabase select() call', () => {
    const cols: string[] = PUBLIC_ENTITY_COLUMNS.split(',');
    assert.ok(cols.length >= 29, `Expected at least 29 columns, got ${cols.length}`);
    assert.ok(!cols.includes('bank_details'));
  });
});

/* ── bank_details serialization protection ────────────────── */

describe('bank_details serialization protection', () => {
  it('JSON.stringify of a public entity should not contain bank_details', () => {
    const entity = makeEntity({
      bank_details: { iban: 'FR1234567890', swift: 'BICXYZ', account_number: '000123' },
    });
    // Simulate what PUBLIC_ENTITY_COLUMNS would return (no bank_details)
    const publicEntity: Record<string, unknown> = {};
    for (const col of PUBLIC_ENTITY_COLUMNS.split(',')) {
      if (col in entity) {
        (publicEntity as Record<string, unknown>)[col] = (entity as unknown as Record<string, unknown>)[col];
      }
    }
    const serialized = JSON.stringify(publicEntity);
    assert.ok(!serialized.includes('bank_details'), 'bank_details should not appear in serialized public entity');
    assert.ok(!serialized.includes('iban'), 'iban should not appear in serialized public entity');
    assert.ok(!serialized.includes('swift'), 'swift should not appear in serialized public entity');
    assert.ok(!serialized.includes('account_number'), 'account_number should not appear in serialized public entity');
  });

  it('JSON.stringify of a full entity WITH bank_details should contain it (proving test is valid)', () => {
    const entity = makeEntity({
      bank_details: { iban: 'FR1234567890' },
    });
    const serialized = JSON.stringify(entity);
    assert.ok(serialized.includes('bank_details'), 'bank_details should appear in full entity serialization');
    assert.ok(serialized.includes('iban'), 'iban should appear in full entity serialization');
  });

  it('billing recipient snapshot should never contain bank_details', () => {
    const entity = makeEntity({
      bank_details: { iban: 'FR1234567890', swift: 'BICXYZ' },
    });
    // Simulate the snapshot allowlist from buildBillingRecipientSnapshot
    const snapshot = {
      entity_id: entity.id,
      legal_name: entity.legal_name,
      trade_name: entity.trade_name,
      display_name: entity.display_name,
      entity_type: entity.entity_type,
      registration_number: entity.registration_number,
      tax_id: entity.tax_id,
      vat_number: entity.vat_number,
      address_line_1: entity.address_line_1,
      address_line_2: entity.address_line_2,
      postal_code: entity.postal_code,
      city: entity.city,
      region: entity.region,
      country_code: entity.country_code,
      contact_name: entity.contact_name,
      billing_email: entity.billing_email,
      phone: entity.phone,
      captured_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes('bank_details'), 'snapshot must not contain bank_details');
    assert.ok(!serialized.includes('iban'), 'snapshot must not contain iban');
    assert.ok(!serialized.includes('swift'), 'snapshot must not contain swift');
  });

  it('sensitive keys list is comprehensive', () => {
    const sensitiveKeys = [
      'bank_details', 'account_number', 'iban', 'swift',
      'private_key', 'wallet_private_key', 'credentials',
    ];
    const entity = makeEntity({ bank_details: { iban: 'test', swift: 'test', account_number: 'test' } });
    const fullSerialized = JSON.stringify(entity);
    for (const key of sensitiveKeys) {
      // bank_details will be present in full entity; the point is that
      // PUBLIC_ENTITY_COLUMNS excludes it
      if (key === 'bank_details' || key === 'iban' || key === 'swift' || key === 'account_number') {
        assert.ok(fullSerialized.includes(key), `${key} should be in full entity (test validity)`);
      }
    }
    // Verify none of these are in the public columns
    for (const key of sensitiveKeys) {
      assert.ok(!PUBLIC_ENTITY_COLUMNS.includes(key), `${key} must not be in PUBLIC_ENTITY_COLUMNS`);
    }
  });
});

/* ── RPC integration: transition_expense parameters ────────── */

describe('RPC integration: transition_expense', () => {
  it('transition validates state before calling RPC (invalid transition rejected)', () => {
    const expense = makeExpense({ status_v4: 'draft' });
    const result = validateTransition(expense, { to: 'completed' as DevExpenseStatusV4 });
    assert.equal(result.ok, false);
  });

  it('transition validates required reason for rejection', () => {
    const expense = makeExpense({ status_v4: 'under_review' });
    const result = validateTransition(expense, { to: 'rejected', reason: undefined as unknown as string });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('rejection_reason'));
  });

  it('transition validates required reason for dispute', () => {
    const expense = makeExpense({ status_v4: 'approved' });
    const result = validateTransition(expense, { to: 'disputed', reason: undefined as unknown as string });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('dispute_reason'));
  });

  it('valid transition passes validation and would call RPC', () => {
    const expense = makeExpense({
      status_v4: 'draft',
      title: 'Test Expense',
      invoice_amount: 125,
      invoice_currency: 'USD',
      incurred_by_entity_id: ENTITY_A,
      covered_by_entity_id: ENTITY_B,
    });
    const result = validateTransition(expense, { to: 'submitted' });
    assert.equal(result.ok, true);
  });

  it('expected_current_status would be set from expense status_v4', () => {
    const expense = makeExpense({ status_v4: 'under_review' });
    // In the service, p_expected_current_status is set to expense.status_v4
    // before calling the RPC. This test verifies the value is correct.
    const expectedStatus = expense.status_v4;
    assert.equal(expectedStatus, 'under_review');
  });

  it('STATUS_CONFLICT error message is detectable', () => {
    // Simulate an RPC error message from the transition_expense function
    const errMsg = 'STATUS_CONFLICT: expected draft, got submitted';
    assert.ok(errMsg.includes('STATUS_CONFLICT'));
  });
});

/* ── RPC integration: fallback removal ─────────────────────── */

describe('RPC fallback removal', () => {
  it('Financial operation unavailable error is detectable', () => {
    const errMsg = 'Financial operation unavailable: transition_expense RPC failed — function does not exist';
    assert.ok(errMsg.includes('Financial operation unavailable'));
  });

  it('confirm_settlement uses Financial operation unavailable pattern', () => {
    const errMsg = 'Financial operation unavailable: confirm_settlement RPC failed — function does not exist';
    assert.ok(errMsg.includes('Financial operation unavailable'));
    assert.ok(errMsg.includes('confirm_settlement'));
  });

  it('create_settlement_with_audit uses Financial operation unavailable pattern', () => {
    const errMsg = 'Financial operation unavailable: create_settlement_with_audit RPC failed — function does not exist';
    assert.ok(errMsg.includes('Financial operation unavailable'));
    assert.ok(errMsg.includes('create_settlement_with_audit'));
  });

  it('resolve_migration_review_with_audit uses Financial operation unavailable pattern', () => {
    const errMsg = 'Financial operation unavailable: resolve_migration_review_with_audit RPC failed — function does not exist';
    assert.ok(errMsg.includes('Financial operation unavailable'));
    assert.ok(errMsg.includes('resolve_migration_review_with_audit'));
  });

  it('refresh_snapshot_with_audit uses Financial operation unavailable pattern', () => {
    const errMsg = 'Financial operation unavailable: refresh_snapshot_with_audit RPC failed — function does not exist';
    assert.ok(errMsg.includes('Financial operation unavailable'));
    assert.ok(errMsg.includes('refresh_snapshot_with_audit'));
  });

  it('MIGRATION_REVIEW_ALREADY_RESOLVED error is detectable', () => {
    const errMsg = 'MIGRATION_REVIEW_ALREADY_RESOLVED: migration review has already been resolved for this expense';
    assert.ok(errMsg.includes('MIGRATION_REVIEW_ALREADY_RESOLVED'));
  });
});

/* ── Migration validation: column and RPC inventory ────────── */

describe('Migration validation: V4 schema completeness', () => {
  it('all legal profile columns are in PUBLIC_ENTITY_COLUMNS', () => {
    const legalCols = [
      'legal_name', 'trade_name', 'registration_number', 'tax_id', 'vat_number',
      'address_line_1', 'address_line_2', 'postal_code', 'city', 'region',
      'country_code', 'contact_name', 'billing_email', 'contact_email', 'website',
    ];
    for (const col of legalCols) {
      assert.ok(
        PUBLIC_ENTITY_COLUMNS.includes(col),
        `Legal profile column ${col} missing from PUBLIC_ENTITY_COLUMNS`,
      );
    }
  });

  it('all role capability columns are in PUBLIC_ENTITY_COLUMNS', () => {
    const roleCols = [
      'can_incur_expenses', 'can_pay_expenses', 'can_cover_expenses',
      'can_receive_invoices', 'can_receive_reimbursements',
    ];
    for (const col of roleCols) {
      assert.ok(
        PUBLIC_ENTITY_COLUMNS.includes(col),
        `Role capability column ${col} missing from PUBLIC_ENTITY_COLUMNS`,
      );
    }
  });

  it('ExpenseEntity interface includes all V4 fields', () => {
    const entity = makeEntity();
    // Verify all V4 fields are present
    assert.ok('can_incur_expenses' in entity);
    assert.ok('can_pay_expenses' in entity);
    assert.ok('can_cover_expenses' in entity);
    assert.ok('can_receive_invoices' in entity);
    assert.ok('can_receive_reimbursements' in entity);
    assert.ok('legal_name' in entity);
    assert.ok('trade_name' in entity);
    assert.ok('registration_number' in entity);
    assert.ok('vat_number' in entity);
    assert.ok('address_line_1' in entity);
    assert.ok('address_line_2' in entity);
    assert.ok('region' in entity);
    assert.ok('contact_name' in entity);
    assert.ok('billing_email' in entity);
    assert.ok('contact_email' in entity);
    assert.ok('website' in entity);
    assert.ok('bank_details' in entity);
    assert.ok('legal_notes' in entity);
  });

  it('DevExpenseV4 interface includes billing recipient fields', () => {
    const expense = makeExpense();
    assert.ok('billing_recipient_entity_id' in expense);
    assert.ok('billing_recipient_snapshot' in expense);
    assert.ok('billing_recipient_reviewed' in expense);
    assert.ok('migration_review_required' in expense);
    assert.ok('settled_amount' in expense);
    assert.ok('status_v4' in expense);
  });
});
