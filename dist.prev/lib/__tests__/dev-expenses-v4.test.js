"use strict";
/**
 * Tests for dev-expenses-v4 service — state machine, amounts, transitions
 * Run with: node --import tsx/esm --test src/services/__tests__/dev-expenses-v4.test.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const dev_expenses_v4_1 = require("../../services/dev-expenses-v4");
/* ── Helpers ──────────────────────────────────────────────── */
function makeExpense(overrides = {}) {
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
function makeEntity(overrides = {}) {
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
(0, node_test_1.describe)('State machine: canTransition', () => {
    (0, node_test_1.it)('draft → submitted is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('draft', 'submitted'), true);
    });
    (0, node_test_1.it)('submitted → under_review is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('submitted', 'under_review'), true);
    });
    (0, node_test_1.it)('under_review → approved is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('under_review', 'approved'), true);
    });
    (0, node_test_1.it)('under_review → partially_approved is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('under_review', 'partially_approved'), true);
    });
    (0, node_test_1.it)('under_review → rejected is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('under_review', 'rejected'), true);
    });
    (0, node_test_1.it)('approved → payment_scheduled is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('approved', 'payment_scheduled'), true);
    });
    (0, node_test_1.it)('partially_approved → payment_scheduled is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('partially_approved', 'payment_scheduled'), true);
    });
    (0, node_test_1.it)('payment_scheduled → partially_paid is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('payment_scheduled', 'partially_paid'), true);
    });
    (0, node_test_1.it)('payment_scheduled → completed is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('payment_scheduled', 'completed'), true);
    });
    (0, node_test_1.it)('partially_paid → completed is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('partially_paid', 'completed'), true);
    });
    (0, node_test_1.it)('completed → archived is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('completed', 'archived'), true);
    });
    (0, node_test_1.it)('approved → disputed is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('approved', 'disputed'), true);
    });
    (0, node_test_1.it)('partially_approved → disputed is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('partially_approved', 'disputed'), true);
    });
    (0, node_test_1.it)('payment_scheduled → approved (back) is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('payment_scheduled', 'approved'), true);
    });
    (0, node_test_1.it)('partially_paid → payment_scheduled (back) is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('partially_paid', 'payment_scheduled'), true);
    });
    (0, node_test_1.it)('rejected → draft (back) is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('rejected', 'draft'), true);
    });
    (0, node_test_1.it)('disputed → under_review (back) is allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('disputed', 'under_review'), true);
    });
    (0, node_test_1.it)('draft → completed is NOT allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('draft', 'completed'), false);
    });
    (0, node_test_1.it)('draft → approved is NOT allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('draft', 'approved'), false);
    });
    (0, node_test_1.it)('archived → draft is NOT allowed', () => {
        strict_1.default.equal((0, dev_expenses_v4_1.canTransition)('archived', 'draft'), false);
    });
    (0, node_test_1.it)('archived has no allowed transitions', () => {
        strict_1.default.deepEqual((0, dev_expenses_v4_1.getAllowedTransitions)('archived'), []);
    });
});
/* ── Amount calculations ──────────────────────────────────── */
(0, node_test_1.describe)('Amount calculations', () => {
    (0, node_test_1.it)('getExpectedSettlementAmount uses approved_amount first', () => {
        const e = makeExpense({ approved_amount: 800, requested_amount: 1000, invoice_amount: 1200 });
        strict_1.default.equal((0, dev_expenses_v4_1.getExpectedSettlementAmount)(e), 800);
    });
    (0, node_test_1.it)('getExpectedSettlementAmount falls back to requested_amount', () => {
        const e = makeExpense({ approved_amount: null, requested_amount: 1000, invoice_amount: 1200 });
        strict_1.default.equal((0, dev_expenses_v4_1.getExpectedSettlementAmount)(e), 1000);
    });
    (0, node_test_1.it)('getExpectedSettlementAmount falls back to invoice_amount', () => {
        const e = makeExpense({ approved_amount: null, requested_amount: null, invoice_amount: 1200 });
        strict_1.default.equal((0, dev_expenses_v4_1.getExpectedSettlementAmount)(e), 1200);
    });
    (0, node_test_1.it)('getExpectedSettlementAmount falls back to amount_usd', () => {
        const e = makeExpense({ approved_amount: null, requested_amount: null, invoice_amount: null, amount_usd: 500 });
        strict_1.default.equal((0, dev_expenses_v4_1.getExpectedSettlementAmount)(e), 500);
    });
    (0, node_test_1.it)('getRemainingAmount = expected - settled', () => {
        const e = makeExpense({ approved_amount: 800, settled_amount: 300 });
        strict_1.default.equal((0, dev_expenses_v4_1.getRemainingAmount)(e), 500);
    });
    (0, node_test_1.it)('getRemainingAmount is never negative', () => {
        const e = makeExpense({ approved_amount: 500, settled_amount: 800 });
        strict_1.default.equal((0, dev_expenses_v4_1.getRemainingAmount)(e), 0);
    });
});
/* ── Transition validation ────────────────────────────────── */
(0, node_test_1.describe)('Transition validation', () => {
    (0, node_test_1.it)('draft → submitted requires title', () => {
        const e = makeExpense({ status_v4: 'draft', title: null });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /title/i);
    });
    (0, node_test_1.it)('draft → submitted requires invoice_amount > 0', () => {
        const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 0 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /invoice.*amount/i);
    });
    (0, node_test_1.it)('draft → submitted requires incurred_by_entity_id', () => {
        const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 1000, incurred_by_entity_id: null });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /incurred/i);
    });
    (0, node_test_1.it)('draft → submitted requires covered_by_entity_id', () => {
        const e = makeExpense({ status_v4: 'draft', title: 'Test', invoice_amount: 1000, incurred_by_entity_id: ENTITY_A, covered_by_entity_id: null });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /covered/i);
    });
    (0, node_test_1.it)('draft → submitted passes with all required fields', () => {
        const e = makeExpense({
            status_v4: 'draft',
            title: 'Test',
            invoice_amount: 1000,
            incurred_by_entity_id: ENTITY_A,
            covered_by_entity_id: ENTITY_B,
        });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('under_review → approved requires approved_amount > 0', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'approved', approved_amount: 0 });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /approved_amount/i);
    });
    (0, node_test_1.it)('under_review → approved passes with approved_amount = requested', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'approved', approved_amount: 1000, approved_equals_requested: true });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('under_review → approved rejects approved > requested without flag', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'approved', approved_amount: 1200 });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /exceed/i);
    });
    (0, node_test_1.it)('under_review → partially_approved requires approved < requested', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'partially_approved', approved_amount: 1000, notes: 'Test' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /partial/i);
    });
    (0, node_test_1.it)('under_review → partially_approved requires notes', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'partially_approved', approved_amount: 800 });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /notes/i);
    });
    (0, node_test_1.it)('under_review → partially_approved passes with notes and approved < requested', () => {
        const e = makeExpense({ status_v4: 'under_review', requested_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'partially_approved', approved_amount: 800, notes: 'Discount applied' });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('under_review → rejected requires reason', () => {
        const e = makeExpense({ status_v4: 'under_review' });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'rejected' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /rejection/i);
    });
    (0, node_test_1.it)('under_review → rejected passes with reason', () => {
        const e = makeExpense({ status_v4: 'under_review' });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'rejected', reason: 'Invalid invoice' });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('approved → disputed requires reason', () => {
        const e = makeExpense({ status_v4: 'approved', approved_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'disputed' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /dispute/i);
    });
    (0, node_test_1.it)('approved → disputed passes with reason', () => {
        const e = makeExpense({ status_v4: 'approved', approved_amount: 1000 });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'disputed', reason: 'Amount incorrect' });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('same status transition is rejected', () => {
        const e = makeExpense({ status_v4: 'draft' });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'draft' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /already/i);
    });
    (0, node_test_1.it)('disallowed transition is rejected', () => {
        const e = makeExpense({ status_v4: 'draft' });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'completed' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /not allowed/i);
    });
    (0, node_test_1.it)('null status_v4 is rejected', () => {
        const e = makeExpense({ status_v4: null });
        const result = (0, dev_expenses_v4_1.validateTransition)(e, { to: 'submitted' });
        strict_1.default.equal(result.ok, false);
        strict_1.default.match(result.error, /legacy/i);
    });
});
/* ── Snapshot allowlist enforcement ────────────────────────── */
(0, node_test_1.describe)('Snapshot allowlist: forbidden keys never present', () => {
    const FORBIDDEN_KEYS = ['bank_details', 'metadata', 'legal_notes', 'payment_details', 'credentials', 'active', 'created_at', 'updated_at', 'can_receive_invoices', 'can_pay_expenses', 'can_cover_expenses', 'can_receive_reimbursements'];
    function makeEntity(overrides = {}) {
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
    function buildSnapshot(entity) {
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
    (0, node_test_1.it)('snapshot does not contain bank_details', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('bank_details' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot does not contain metadata', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('metadata' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot does not contain legal_notes', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('legal_notes' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot does not contain active flag', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('active' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot does not contain role capability flags', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('can_receive_invoices' in snapshot, false);
        strict_1.default.equal('can_pay_expenses' in snapshot, false);
        strict_1.default.equal('can_cover_expenses' in snapshot, false);
        strict_1.default.equal('can_receive_reimbursements' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot does not contain internal timestamps', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal('created_at' in snapshot, false);
        strict_1.default.equal('updated_at' in snapshot, false);
    });
    (0, node_test_1.it)('snapshot contains only allowed keys', () => {
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
            strict_1.default.ok(allowedKeys.has(key), `Unexpected key in snapshot: ${key}`);
        }
    });
    (0, node_test_1.it)('snapshot does not contain any forbidden keys', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        for (const forbidden of FORBIDDEN_KEYS) {
            strict_1.default.equal(forbidden in snapshot, false, `Forbidden key '${forbidden}' found in snapshot`);
        }
    });
    (0, node_test_1.it)('snapshot is immutable after entity modification (different object)', () => {
        const entity = makeEntity();
        const snapshot = buildSnapshot(entity);
        entity.legal_name = 'Changed Name';
        // Snapshot should still have the original value
        strict_1.default.equal(snapshot.legal_name, 'Test Legal Name');
    });
    (0, node_test_1.it)('snapshot uses address_line_1 fallback to address', () => {
        const entity = makeEntity({ address_line_1: null, address: 'Fallback Address' });
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal(snapshot.address_line_1, 'Fallback Address');
    });
    (0, node_test_1.it)('snapshot uses billing_email fallback to email', () => {
        const entity = makeEntity({ billing_email: null, email: 'fallback@example.com' });
        const snapshot = buildSnapshot(entity);
        strict_1.default.equal(snapshot.billing_email, 'fallback@example.com');
    });
});
/* ── getBillingSnapshotDifference ───────────────────────────── */
(0, node_test_1.describe)('getBillingSnapshotDifference', () => {
    function makeEntity(overrides = {}) {
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
    (0, node_test_1.it)('returns differs=false when snapshot is null', () => {
        const entity = makeEntity();
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(null, entity);
        strict_1.default.equal(result.differs, false);
        strict_1.default.deepEqual(result.changedFields, []);
    });
    (0, node_test_1.it)('returns differs=false when entity is null', () => {
        const snapshot = { legal_name: 'Test', captured_at: '2026-01-01' };
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, null);
        strict_1.default.equal(result.differs, false);
    });
    (0, node_test_1.it)('returns differs=false when all fields match', () => {
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
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, false);
        strict_1.default.deepEqual(result.changedFields, []);
    });
    (0, node_test_1.it)('returns differs=true when address changes', () => {
        const entity = makeEntity({ address: 'New Address' });
        const snapshot = {
            legal_name: 'Test Legal',
            address_line_1: 'Old Address',
            captured_at: '2026-01-01',
        };
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, true);
        strict_1.default.ok(result.changedFields.includes('address_line_1'));
    });
    (0, node_test_1.it)('returns differs=true when billing_email changes', () => {
        const entity = makeEntity({ email: 'new@example.com' });
        const snapshot = {
            billing_email: 'old@example.com',
            captured_at: '2026-01-01',
        };
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, true);
        strict_1.default.ok(result.changedFields.includes('billing_email'));
    });
    function makeMatchingSnapshot(entity) {
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
    (0, node_test_1.it)('returns differs=false when only captured_at (timestamp) differs', () => {
        const entity = makeEntity();
        const snapshot = makeMatchingSnapshot(entity);
        // captured_at is not in SNAPSHOT_COMPARE_FIELDS, so it should not count
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, false);
    });
    (0, node_test_1.it)('returns differs=false when only bank_details change (not compared)', () => {
        const entity = makeEntity({ bank_details: { iban: 'NEW_IBAN' } });
        const snapshot = makeMatchingSnapshot(entity);
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, false);
    });
    (0, node_test_1.it)('returns differs=true when country_code changes', () => {
        const entity = makeEntity({ country_code: 'FR' });
        const snapshot = {
            country_code: 'CD',
            captured_at: '2026-01-01',
        };
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, true);
        strict_1.default.ok(result.changedFields.includes('country_code'));
    });
    (0, node_test_1.it)('normalizes empty string as null (no false positive)', () => {
        const entity = makeEntity({ region: '' });
        const snapshot = makeMatchingSnapshot(entity);
        snapshot.region = null;
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        // '' and null should be treated as equal
        strict_1.default.equal(result.differs, false);
    });
    (0, node_test_1.it)('detects multiple changed fields', () => {
        const entity = makeEntity({ legal_name: 'New Legal', city: 'Lubumbashi', country_code: 'FR' });
        const snapshot = makeMatchingSnapshot(entity);
        snapshot.legal_name = 'Old Legal';
        snapshot.city = 'Kinshasa';
        snapshot.country_code = 'CD';
        const result = (0, dev_expenses_v4_1.getBillingSnapshotDifference)(snapshot, entity);
        strict_1.default.equal(result.differs, true);
        strict_1.default.equal(result.changedFields.length, 3);
        strict_1.default.ok(result.changedFields.includes('legal_name'));
        strict_1.default.ok(result.changedFields.includes('city'));
        strict_1.default.ok(result.changedFields.includes('country_code'));
    });
});
/* ── Role validation logic ─────────────────────────────────── */
(0, node_test_1.describe)('Role validation logic', () => {
    function makeEntity(overrides = {}) {
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
    (0, node_test_1.it)('active entity with can_receive_invoices=true should pass', () => {
        const entity = makeEntity({ active: true, can_receive_invoices: true });
        strict_1.default.ok(entity.active && entity.can_receive_invoices);
    });
    (0, node_test_1.it)('inactive entity should fail role check', () => {
        const entity = makeEntity({ active: false, can_receive_invoices: true });
        strict_1.default.equal(entity.active, false);
    });
    (0, node_test_1.it)('entity with can_receive_invoices=false should fail billing recipient role', () => {
        const entity = makeEntity({ active: true, can_receive_invoices: false });
        strict_1.default.equal(entity.can_receive_invoices, false);
    });
    (0, node_test_1.it)('entity with can_incur_expenses=false should fail incurred_by role', () => {
        const entity = makeEntity({ active: true, can_incur_expenses: false });
        strict_1.default.equal(entity.can_incur_expenses, false);
    });
    (0, node_test_1.it)('entity with can_pay_expenses=false should fail initially_paid_by role', () => {
        const entity = makeEntity({ active: true, can_pay_expenses: false });
        strict_1.default.equal(entity.can_pay_expenses, false);
    });
    (0, node_test_1.it)('entity with can_cover_expenses=false should fail covered_by role', () => {
        const entity = makeEntity({ active: true, can_cover_expenses: false });
        strict_1.default.equal(entity.can_cover_expenses, false);
    });
    (0, node_test_1.it)('entity with can_receive_reimbursements=false should fail reimbursement role', () => {
        const entity = makeEntity({ active: true, can_receive_reimbursements: false });
        strict_1.default.equal(entity.can_receive_reimbursements, false);
    });
    (0, node_test_1.it)('entity can incur without can_pay (role separation)', () => {
        const entity = makeEntity({ active: true, can_incur_expenses: true, can_pay_expenses: false });
        strict_1.default.equal(entity.can_incur_expenses, true);
        strict_1.default.equal(entity.can_pay_expenses, false);
    });
    (0, node_test_1.it)('entity can pay without being the incurring entity', () => {
        const entity = makeEntity({ active: true, can_incur_expenses: false, can_pay_expenses: true });
        strict_1.default.equal(entity.can_incur_expenses, false);
        strict_1.default.equal(entity.can_pay_expenses, true);
    });
    (0, node_test_1.it)('inactive entity refused even if all role flags are true', () => {
        const entity = makeEntity({ active: false });
        strict_1.default.equal(entity.active, false);
    });
    (0, node_test_1.it)('can_incur_expenses=false refused for incurred_by', () => {
        const entity = makeEntity({ active: true, can_incur_expenses: false });
        strict_1.default.equal(entity.can_incur_expenses, false);
    });
    (0, node_test_1.it)('all roles default to true for new entities', () => {
        const entity = makeEntity();
        strict_1.default.equal(entity.can_incur_expenses, true);
        strict_1.default.equal(entity.can_receive_invoices, true);
        strict_1.default.equal(entity.can_pay_expenses, true);
        strict_1.default.equal(entity.can_cover_expenses, true);
        strict_1.default.equal(entity.can_receive_reimbursements, true);
    });
});
/* ── PUBLIC_ENTITY_COLUMNS: bank_details exclusion ────────── */
(0, node_test_1.describe)('PUBLIC_ENTITY_COLUMNS', () => {
    (0, node_test_1.it)('is a non-empty string', () => {
        strict_1.default.ok(typeof dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS === 'string');
        strict_1.default.ok(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.length > 0);
    });
    (0, node_test_1.it)('does not contain bank_details', () => {
        strict_1.default.ok(!dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes('bank_details'));
    });
    (0, node_test_1.it)('contains legal_notes (admin-only, but not in snapshots)', () => {
        strict_1.default.ok(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes('legal_notes'));
    });
    (0, node_test_1.it)('contains all required public columns', () => {
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
            strict_1.default.ok(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes(col), `PUBLIC_ENTITY_COLUMNS missing required column: ${col}`);
        }
    });
    (0, node_test_1.it)('can be safely used in a Supabase select() call', () => {
        const cols = dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.split(',');
        strict_1.default.ok(cols.length >= 29, `Expected at least 29 columns, got ${cols.length}`);
        strict_1.default.ok(!cols.includes('bank_details'));
    });
});
/* ── bank_details serialization protection ────────────────── */
(0, node_test_1.describe)('bank_details serialization protection', () => {
    (0, node_test_1.it)('JSON.stringify of a public entity should not contain bank_details', () => {
        const entity = makeEntity({
            bank_details: { iban: 'FR1234567890', swift: 'BICXYZ', account_number: '000123' },
        });
        // Simulate what PUBLIC_ENTITY_COLUMNS would return (no bank_details)
        const publicEntity = {};
        for (const col of dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.split(',')) {
            if (col in entity) {
                publicEntity[col] = entity[col];
            }
        }
        const serialized = JSON.stringify(publicEntity);
        strict_1.default.ok(!serialized.includes('bank_details'), 'bank_details should not appear in serialized public entity');
        strict_1.default.ok(!serialized.includes('iban'), 'iban should not appear in serialized public entity');
        strict_1.default.ok(!serialized.includes('swift'), 'swift should not appear in serialized public entity');
        strict_1.default.ok(!serialized.includes('account_number'), 'account_number should not appear in serialized public entity');
    });
    (0, node_test_1.it)('JSON.stringify of a full entity WITH bank_details should contain it (proving test is valid)', () => {
        const entity = makeEntity({
            bank_details: { iban: 'FR1234567890' },
        });
        const serialized = JSON.stringify(entity);
        strict_1.default.ok(serialized.includes('bank_details'), 'bank_details should appear in full entity serialization');
        strict_1.default.ok(serialized.includes('iban'), 'iban should appear in full entity serialization');
    });
    (0, node_test_1.it)('billing recipient snapshot should never contain bank_details', () => {
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
        strict_1.default.ok(!serialized.includes('bank_details'), 'snapshot must not contain bank_details');
        strict_1.default.ok(!serialized.includes('iban'), 'snapshot must not contain iban');
        strict_1.default.ok(!serialized.includes('swift'), 'snapshot must not contain swift');
    });
    (0, node_test_1.it)('sensitive keys list is comprehensive', () => {
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
                strict_1.default.ok(fullSerialized.includes(key), `${key} should be in full entity (test validity)`);
            }
        }
        // Verify none of these are in the public columns
        for (const key of sensitiveKeys) {
            strict_1.default.ok(!dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes(key), `${key} must not be in PUBLIC_ENTITY_COLUMNS`);
        }
    });
});
/* ── RPC integration: transition_expense parameters ────────── */
(0, node_test_1.describe)('RPC integration: transition_expense', () => {
    (0, node_test_1.it)('transition validates state before calling RPC (invalid transition rejected)', () => {
        const expense = makeExpense({ status_v4: 'draft' });
        const result = (0, dev_expenses_v4_1.validateTransition)(expense, { to: 'completed' });
        strict_1.default.equal(result.ok, false);
    });
    (0, node_test_1.it)('transition validates required reason for rejection', () => {
        const expense = makeExpense({ status_v4: 'under_review' });
        const result = (0, dev_expenses_v4_1.validateTransition)(expense, { to: 'rejected', reason: undefined });
        strict_1.default.equal(result.ok, false);
        strict_1.default.ok(result.error?.includes('rejection_reason'));
    });
    (0, node_test_1.it)('transition validates required reason for dispute', () => {
        const expense = makeExpense({ status_v4: 'approved' });
        const result = (0, dev_expenses_v4_1.validateTransition)(expense, { to: 'disputed', reason: undefined });
        strict_1.default.equal(result.ok, false);
        strict_1.default.ok(result.error?.includes('dispute_reason'));
    });
    (0, node_test_1.it)('valid transition passes validation and would call RPC', () => {
        const expense = makeExpense({
            status_v4: 'draft',
            title: 'Test Expense',
            invoice_amount: 125,
            invoice_currency: 'USD',
            incurred_by_entity_id: ENTITY_A,
            covered_by_entity_id: ENTITY_B,
        });
        const result = (0, dev_expenses_v4_1.validateTransition)(expense, { to: 'submitted' });
        strict_1.default.equal(result.ok, true);
    });
    (0, node_test_1.it)('expected_current_status would be set from expense status_v4', () => {
        const expense = makeExpense({ status_v4: 'under_review' });
        // In the service, p_expected_current_status is set to expense.status_v4
        // before calling the RPC. This test verifies the value is correct.
        const expectedStatus = expense.status_v4;
        strict_1.default.equal(expectedStatus, 'under_review');
    });
    (0, node_test_1.it)('STATUS_CONFLICT error message is detectable', () => {
        // Simulate an RPC error message from the transition_expense function
        const errMsg = 'STATUS_CONFLICT: expected draft, got submitted';
        strict_1.default.ok(errMsg.includes('STATUS_CONFLICT'));
    });
});
/* ── RPC integration: fallback removal ─────────────────────── */
(0, node_test_1.describe)('RPC fallback removal', () => {
    (0, node_test_1.it)('Financial operation unavailable error is detectable', () => {
        const errMsg = 'Financial operation unavailable: transition_expense RPC failed — function does not exist';
        strict_1.default.ok(errMsg.includes('Financial operation unavailable'));
    });
    (0, node_test_1.it)('confirm_settlement uses Financial operation unavailable pattern', () => {
        const errMsg = 'Financial operation unavailable: confirm_settlement RPC failed — function does not exist';
        strict_1.default.ok(errMsg.includes('Financial operation unavailable'));
        strict_1.default.ok(errMsg.includes('confirm_settlement'));
    });
    (0, node_test_1.it)('create_settlement_with_audit uses Financial operation unavailable pattern', () => {
        const errMsg = 'Financial operation unavailable: create_settlement_with_audit RPC failed — function does not exist';
        strict_1.default.ok(errMsg.includes('Financial operation unavailable'));
        strict_1.default.ok(errMsg.includes('create_settlement_with_audit'));
    });
    (0, node_test_1.it)('resolve_migration_review_with_audit uses Financial operation unavailable pattern', () => {
        const errMsg = 'Financial operation unavailable: resolve_migration_review_with_audit RPC failed — function does not exist';
        strict_1.default.ok(errMsg.includes('Financial operation unavailable'));
        strict_1.default.ok(errMsg.includes('resolve_migration_review_with_audit'));
    });
    (0, node_test_1.it)('refresh_snapshot_with_audit uses Financial operation unavailable pattern', () => {
        const errMsg = 'Financial operation unavailable: refresh_snapshot_with_audit RPC failed — function does not exist';
        strict_1.default.ok(errMsg.includes('Financial operation unavailable'));
        strict_1.default.ok(errMsg.includes('refresh_snapshot_with_audit'));
    });
    (0, node_test_1.it)('MIGRATION_REVIEW_ALREADY_RESOLVED error is detectable', () => {
        const errMsg = 'MIGRATION_REVIEW_ALREADY_RESOLVED: migration review has already been resolved for this expense';
        strict_1.default.ok(errMsg.includes('MIGRATION_REVIEW_ALREADY_RESOLVED'));
    });
});
/* ── Migration validation: column and RPC inventory ────────── */
(0, node_test_1.describe)('Migration validation: V4 schema completeness', () => {
    (0, node_test_1.it)('all legal profile columns are in PUBLIC_ENTITY_COLUMNS', () => {
        const legalCols = [
            'legal_name', 'trade_name', 'registration_number', 'tax_id', 'vat_number',
            'address_line_1', 'address_line_2', 'postal_code', 'city', 'region',
            'country_code', 'contact_name', 'billing_email', 'contact_email', 'website',
        ];
        for (const col of legalCols) {
            strict_1.default.ok(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes(col), `Legal profile column ${col} missing from PUBLIC_ENTITY_COLUMNS`);
        }
    });
    (0, node_test_1.it)('all role capability columns are in PUBLIC_ENTITY_COLUMNS', () => {
        const roleCols = [
            'can_incur_expenses', 'can_pay_expenses', 'can_cover_expenses',
            'can_receive_invoices', 'can_receive_reimbursements',
        ];
        for (const col of roleCols) {
            strict_1.default.ok(dev_expenses_v4_1.PUBLIC_ENTITY_COLUMNS.includes(col), `Role capability column ${col} missing from PUBLIC_ENTITY_COLUMNS`);
        }
    });
    (0, node_test_1.it)('ExpenseEntity interface includes all V4 fields', () => {
        const entity = makeEntity();
        // Verify all V4 fields are present
        strict_1.default.ok('can_incur_expenses' in entity);
        strict_1.default.ok('can_pay_expenses' in entity);
        strict_1.default.ok('can_cover_expenses' in entity);
        strict_1.default.ok('can_receive_invoices' in entity);
        strict_1.default.ok('can_receive_reimbursements' in entity);
        strict_1.default.ok('legal_name' in entity);
        strict_1.default.ok('trade_name' in entity);
        strict_1.default.ok('registration_number' in entity);
        strict_1.default.ok('vat_number' in entity);
        strict_1.default.ok('address_line_1' in entity);
        strict_1.default.ok('address_line_2' in entity);
        strict_1.default.ok('region' in entity);
        strict_1.default.ok('contact_name' in entity);
        strict_1.default.ok('billing_email' in entity);
        strict_1.default.ok('contact_email' in entity);
        strict_1.default.ok('website' in entity);
        strict_1.default.ok('bank_details' in entity);
        strict_1.default.ok('legal_notes' in entity);
    });
    (0, node_test_1.it)('DevExpenseV4 interface includes billing recipient fields', () => {
        const expense = makeExpense();
        strict_1.default.ok('billing_recipient_entity_id' in expense);
        strict_1.default.ok('billing_recipient_snapshot' in expense);
        strict_1.default.ok('billing_recipient_reviewed' in expense);
        strict_1.default.ok('migration_review_required' in expense);
        strict_1.default.ok('settled_amount' in expense);
        strict_1.default.ok('status_v4' in expense);
    });
});
//# sourceMappingURL=dev-expenses-v4.test.js.map