/**
 * Dev Expenses V4 — Central business service
 *
 * State machine, settlements, audit, amount calculations.
 * All financial logic lives here, not in route handlers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
/**
 * Columns that are safe to expose in API responses.
 * NEVER includes: bank_details, metadata (internal), legal_notes (internal).
 * Use this constant for ALL selects on expense_entities in routes and services.
 */
export declare const PUBLIC_ENTITY_COLUMNS: string;
export type DevExpenseStatusV4 = 'draft' | 'submitted' | 'under_review' | 'approved' | 'partially_approved' | 'rejected' | 'payment_scheduled' | 'partially_paid' | 'completed' | 'disputed' | 'cancelled' | 'archived';
export type InitialPaymentStatus = 'unpaid' | 'paid_by_incurred_entity' | 'paid_by_covering_entity' | 'paid_by_third_party' | 'unknown';
export type SettlementType = 'supplier_payment' | 'reimbursement' | 'partial_reimbursement' | 'internal_offset' | 'adjustment' | 'other';
export type SettlementStatus = 'scheduled' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type ActorType = 'admin' | 'system' | 'cron' | 'migration' | 'api';
export interface DevExpenseV4 {
    id: string;
    title: string | null;
    description: string | null;
    category: string;
    creditor_id: string | null;
    project_code: string;
    project_ref: string | null;
    quote_id: string | null;
    billing_month: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    incurred_by_entity_id: string | null;
    initially_paid_by_entity_id: string | null;
    covered_by_entity_id: string | null;
    reimbursement_recipient_entity_id: string | null;
    billing_recipient_entity_id: string | null;
    billing_recipient_snapshot: Record<string, unknown> | null;
    billing_recipient_reviewed: boolean;
    amount_usd: number;
    invoice_amount: number | null;
    invoice_currency: string;
    requested_amount: number | null;
    approved_amount: number | null;
    settled_amount: number;
    initial_payment_status: InitialPaymentStatus | null;
    initial_payment_method: string | null;
    status_v4: DevExpenseStatusV4 | null;
    status: string;
    submitted_at: string | null;
    review_started_at: string | null;
    approved_at: string | null;
    payment_scheduled_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    rejection_reason: string | null;
    dispute_reason: string | null;
    internal_notes_v4: string | null;
    migration_review_required: boolean;
    migration_notes: string | null;
    legacy_status: string | null;
    legacy_funded_by: string | null;
    legacy_paid_by: string | null;
    archived: boolean;
    archived_at: string | null;
    paid_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface Settlement {
    id: string;
    expense_id: string;
    settlement_type: SettlementType;
    payer_entity_id: string | null;
    recipient_entity_id: string | null;
    amount: number;
    currency: string;
    payment_method: string | null;
    transaction_reference: string | null;
    status: SettlementStatus;
    scheduled_at: string | null;
    executed_at: string | null;
    confirmed_at: string | null;
    proof_file_url: string | null;
    notes: string | null;
    idempotency_key: string | null;
    created_at: string;
    updated_at: string;
}
export interface AuditEvent {
    id: string;
    expense_id: string;
    event_type: string;
    previous_status: string | null;
    new_status: string | null;
    actor_type: ActorType;
    actor_id: string | null;
    actor_name: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
}
export interface ExpenseEntity {
    id: string;
    code: string;
    display_name: string;
    entity_type: string;
    legal_name: string | null;
    trade_name: string | null;
    country_code: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    postal_code: string | null;
    tax_id: string | null;
    registration_number: string | null;
    vat_number: string | null;
    address_line_1: string | null;
    address_line_2: string | null;
    region: string | null;
    contact_name: string | null;
    billing_email: string | null;
    contact_email: string | null;
    website: string | null;
    legal_notes: string | null;
    can_incur_expenses: boolean;
    can_receive_invoices: boolean;
    can_pay_expenses: boolean;
    can_cover_expenses: boolean;
    can_receive_reimbursements: boolean;
    bank_details: Record<string, unknown>;
    active: boolean;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}
export declare function canTransition(from: DevExpenseStatusV4, to: DevExpenseStatusV4): boolean;
export declare function getAllowedTransitions(from: DevExpenseStatusV4): DevExpenseStatusV4[];
/**
 * Priority: approved_amount → requested_amount → invoice_amount → amount_usd
 * Never duplicate this logic in routes.
 */
export declare function getExpectedSettlementAmount(expense: DevExpenseV4): number;
/**
 * max(expectedSettlementAmount - settledAmount, 0)
 */
export declare function getRemainingAmount(expense: DevExpenseV4): number;
export interface BillingSnapshotDiff {
    differs: boolean;
    changedFields: string[];
}
/**
 * Compare a billing recipient snapshot against the current entity profile.
 * Only compares legal/contact fields — never bank_details, metadata, active,
 * role flags, timestamps, or internal notes.
 */
export declare function getBillingSnapshotDifference(snapshot: Record<string, unknown> | null, entity: {
    legal_name?: string | null;
    trade_name?: string | null;
    registration_number?: string | null;
    tax_id?: string | null;
    vat_number?: string | null;
    address_line_1?: string | null;
    address_line_2?: string | null;
    postal_code?: string | null;
    city?: string | null;
    region?: string | null;
    country_code?: string | null;
    contact_name?: string | null;
    billing_email?: string | null;
    phone?: string | null;
    address?: string | null;
    email?: string | null;
} | null): BillingSnapshotDiff;
export interface TransitionContext {
    to: DevExpenseStatusV4;
    approved_amount?: number | null;
    reason?: string | null;
    notes?: string | null;
    approved_equals_requested?: boolean;
}
export interface TransitionValidationResult {
    ok: boolean;
    error?: string;
    fields?: Record<string, unknown>;
}
export declare function validateTransition(expense: DevExpenseV4, ctx: TransitionContext): TransitionValidationResult;
export interface AuditInput {
    expense_id: string;
    event_type: string;
    previous_status: string | null;
    new_status: string | null;
    actor_type?: ActorType;
    actor_id?: string | null;
    actor_name?: string | null;
    metadata?: Record<string, unknown>;
}
export declare function createAuditEvent(supabase: SupabaseClient, input: AuditInput): Promise<void>;
/**
 * Recalculate settled_amount from the sum of completed settlements.
 * Done in SQL to avoid float precision issues.
 */
export declare function recalculateSettledAmount(supabase: SupabaseClient, expenseId: string): Promise<number>;
export interface ActorInfo {
    actor_type: ActorType;
    actor_id: string | null;
    actor_name: string | null;
}
export declare class DevExpensesV4Service {
    private supabase;
    constructor(supabase: SupabaseClient);
    getExpense(id: string): Promise<DevExpenseV4 | null>;
    getExpenseDetail(id: string): Promise<{
        expense: DevExpenseV4;
        settlements: any[];
        audit_events: any[];
        entities: Record<string, ExpenseEntity>;
        quote: any;
        expected_amount: number;
        remaining_amount: number;
        allowed_transitions: DevExpenseStatusV4[];
    } | null>;
    private fetchEntities;
    /**
     * Validate that an entity is active and has the required role capability.
     * Throws if the entity is inactive or lacks the required permission.
     */
    private validateEntityRole;
    /**
     * Build a billing recipient snapshot using an EXPLICIT ALLOWLIST.
     * Never copies: bank_details, metadata, legal_notes, active, role flags,
     * created_at, updated_at, or any internal field.
     */
    private buildBillingRecipientSnapshot;
    private fetchEntitySnapshot;
    refreshSnapshot(expenseId: string, actor: ActorInfo): Promise<DevExpenseV4>;
    listExpenses(params: {
        page?: number;
        limit?: number;
        search?: string;
        status?: string;
        supplier_id?: string;
        incurred_by_entity_id?: string;
        covered_by_entity_id?: string;
        billing_recipient_entity_id?: string;
        currency?: string;
        date_from?: string;
        date_to?: string;
        archived?: boolean;
        migration_review_required?: boolean;
        sort?: string;
        order?: 'asc' | 'desc';
    }): Promise<{
        items: DevExpenseV4[];
        pagination: {
            page: number;
            limit: number;
            total: number;
            pages: number;
        };
    }>;
    createExpense(input: Record<string, unknown>, actor: ActorInfo): Promise<DevExpenseV4>;
    updateExpense(id: string, updates: Record<string, unknown>, actor: ActorInfo): Promise<DevExpenseV4>;
    transition(id: string, ctx: TransitionContext, actor: ActorInfo): Promise<DevExpenseV4>;
    listSettlements(expenseId: string): Promise<Settlement[]>;
    createSettlement(expenseId: string, input: {
        settlement_type: SettlementType;
        payer_entity_id?: string | null;
        recipient_entity_id?: string | null;
        amount: number;
        currency?: string;
        payment_method?: string | null;
        transaction_reference?: string | null;
        scheduled_at?: string | null;
        notes?: string | null;
        idempotency_key?: string | null;
    }, actor: ActorInfo): Promise<Settlement>;
    updateSettlement(expenseId: string, settlementId: string, updates: Record<string, unknown>, actor: ActorInfo): Promise<Settlement>;
    private recalculateAndApplySettled;
    private checkAutoTransition;
    listAuditEvents(expenseId: string): Promise<AuditEvent[]>;
    resolveMigrationReview(id: string, input: {
        status?: DevExpenseStatusV4;
        incurred_by_entity_id?: string | null;
        initially_paid_by_entity_id?: string | null;
        covered_by_entity_id?: string | null;
        reimbursement_recipient_entity_id?: string | null;
        billing_recipient_entity_id?: string | null;
        approved_amount?: number | null;
        settled_amount?: number | null;
        notes?: string;
    }, actor: ActorInfo): Promise<DevExpenseV4>;
    getStats(): Promise<{
        total_engaged: Record<string, number>;
        awaiting_validation: Record<string, number>;
        approved_to_pay: Record<string, number>;
        payment_scheduled: Record<string, number>;
        settled_this_month: Record<string, number>;
        remaining_due: Record<string, number>;
        overdue_count: number;
        migration_review_count: number;
    }>;
}
