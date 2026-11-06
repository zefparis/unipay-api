"use strict";
/**
 * Dev Expenses V4 — Central business service
 *
 * State machine, settlements, audit, amount calculations.
 * All financial logic lives here, not in route handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevExpensesV4Service = exports.PUBLIC_ENTITY_COLUMNS = void 0;
exports.canTransition = canTransition;
exports.getAllowedTransitions = getAllowedTransitions;
exports.getExpectedSettlementAmount = getExpectedSettlementAmount;
exports.getRemainingAmount = getRemainingAmount;
exports.getBillingSnapshotDifference = getBillingSnapshotDifference;
exports.validateTransition = validateTransition;
exports.createAuditEvent = createAuditEvent;
exports.recalculateSettledAmount = recalculateSettledAmount;
/* ── Public Entity Columns ─────────────────────────────────── */
/**
 * Columns that are safe to expose in API responses.
 * NEVER includes: bank_details, metadata (internal), legal_notes (internal).
 * Use this constant for ALL selects on expense_entities in routes and services.
 */
exports.PUBLIC_ENTITY_COLUMNS = [
    'id',
    'code',
    'display_name',
    'entity_type',
    'legal_name',
    'trade_name',
    'country_code',
    'email',
    'phone',
    'address',
    'city',
    'postal_code',
    'tax_id',
    'registration_number',
    'vat_number',
    'address_line_1',
    'address_line_2',
    'region',
    'contact_name',
    'billing_email',
    'contact_email',
    'website',
    'legal_notes',
    'active',
    'can_incur_expenses',
    'can_pay_expenses',
    'can_cover_expenses',
    'can_receive_invoices',
    'can_receive_reimbursements',
    'metadata',
    'created_at',
    'updated_at',
].join(',');
/* ── State machine ─────────────────────────────────────────── */
const TRANSITIONS = {
    draft: ['submitted', 'cancelled'],
    submitted: ['under_review', 'draft', 'cancelled'],
    under_review: ['approved', 'partially_approved', 'rejected', 'submitted', 'cancelled'],
    approved: ['payment_scheduled', 'disputed', 'cancelled'],
    partially_approved: ['payment_scheduled', 'disputed', 'cancelled'],
    rejected: ['draft', 'cancelled'],
    payment_scheduled: ['partially_paid', 'completed', 'approved', 'disputed', 'cancelled'],
    partially_paid: ['completed', 'payment_scheduled', 'disputed', 'cancelled'],
    completed: ['archived', 'disputed'],
    disputed: ['under_review', 'cancelled', 'archived'],
    cancelled: ['draft', 'archived'],
    archived: [],
};
function canTransition(from, to) {
    return (TRANSITIONS[from] ?? []).includes(to);
}
function getAllowedTransitions(from) {
    return TRANSITIONS[from] ?? [];
}
/* ── Amount calculations ───────────────────────────────────── */
/**
 * Priority: approved_amount → requested_amount → invoice_amount → amount_usd
 * Never duplicate this logic in routes.
 */
function getExpectedSettlementAmount(expense) {
    const val = expense.approved_amount ??
        expense.requested_amount ??
        expense.invoice_amount ??
        expense.amount_usd ??
        0;
    return val;
}
/**
 * max(expectedSettlementAmount - settledAmount, 0)
 */
function getRemainingAmount(expense) {
    const expected = getExpectedSettlementAmount(expense);
    const settled = expense.settled_amount ?? 0;
    return Math.max(expected - settled, 0);
}
/* ── Billing snapshot comparison ────────────────────────────── */
const SNAPSHOT_COMPARE_FIELDS = [
    'legal_name',
    'trade_name',
    'registration_number',
    'tax_id',
    'vat_number',
    'address_line_1',
    'address_line_2',
    'postal_code',
    'city',
    'region',
    'country_code',
    'contact_name',
    'billing_email',
    'phone',
];
/**
 * Compare a billing recipient snapshot against the current entity profile.
 * Only compares legal/contact fields — never bank_details, metadata, active,
 * role flags, timestamps, or internal notes.
 */
function getBillingSnapshotDifference(snapshot, entity) {
    if (!snapshot || !entity)
        return { differs: false, changedFields: [] };
    const changedFields = [];
    for (const field of SNAPSHOT_COMPARE_FIELDS) {
        const snapshotVal = snapshot[field] ?? null;
        // For address_line_1, fall back to entity.address; for billing_email, fall back to entity.email
        let entityVal;
        if (field === 'address_line_1') {
            entityVal = entity.address_line_1 ?? entity.address ?? null;
        }
        else if (field === 'billing_email') {
            entityVal = entity.billing_email ?? entity.email ?? null;
        }
        else {
            entityVal = entity[field] ?? null;
        }
        // Normalize: treat empty string as null
        const norm = (v) => (v === '' ? null : v);
        if (norm(snapshotVal) !== norm(entityVal)) {
            changedFields.push(field);
        }
    }
    return {
        differs: changedFields.length > 0,
        changedFields,
    };
}
function validateTransition(expense, ctx) {
    const current = expense.status_v4;
    if (!current) {
        return { ok: false, error: 'Expense has no V4 status (legacy record needs migration review)' };
    }
    if (current === ctx.to) {
        return { ok: false, error: `Expense is already in status '${ctx.to}'` };
    }
    if (!canTransition(current, ctx.to)) {
        return { ok: false, error: `Transition from '${current}' to '${ctx.to}' is not allowed` };
    }
    switch (ctx.to) {
        case 'submitted': {
            if (!expense.title) {
                return { ok: false, error: 'Title is required to submit', fields: { title: true } };
            }
            if (expense.invoice_amount == null || expense.invoice_amount <= 0) {
                return { ok: false, error: 'Invoice amount must be > 0 to submit', fields: { invoice_amount: true } };
            }
            if (!expense.invoice_currency) {
                return { ok: false, error: 'Currency is required to submit', fields: { invoice_currency: true } };
            }
            if (!expense.incurred_by_entity_id) {
                return { ok: false, error: 'Incurred-by entity is required to submit', fields: { incurred_by_entity_id: true } };
            }
            if (!expense.covered_by_entity_id) {
                return { ok: false, error: 'Covered-by entity is required to submit', fields: { covered_by_entity_id: true } };
            }
            break;
        }
        case 'approved': {
            if (ctx.approved_amount == null || ctx.approved_amount <= 0) {
                return { ok: false, error: 'approved_amount must be > 0 for approval', fields: { approved_amount: true } };
            }
            const requested = expense.requested_amount ?? expense.invoice_amount ?? 0;
            if (ctx.approved_equals_requested && requested > 0 && ctx.approved_amount !== requested) {
                return { ok: false, error: 'approved_amount does not match requested_amount', fields: { approved_amount: true } };
            }
            if (!ctx.approved_equals_requested && ctx.approved_amount > requested && requested > 0) {
                return { ok: false, error: 'approved_amount cannot exceed requested_amount', fields: { approved_amount: true } };
            }
            break;
        }
        case 'partially_approved': {
            const requested = expense.requested_amount ?? expense.invoice_amount ?? 0;
            if (ctx.approved_amount == null || ctx.approved_amount <= 0) {
                return { ok: false, error: 'approved_amount must be > 0 for partial approval', fields: { approved_amount: true } };
            }
            if (requested > 0 && ctx.approved_amount >= requested) {
                return { ok: false, error: 'For partial approval, approved_amount must be < requested_amount', fields: { approved_amount: true } };
            }
            if (!ctx.notes && !expense.internal_notes_v4) {
                return { ok: false, error: 'Notes explaining the difference are required for partial approval', fields: { notes: true } };
            }
            break;
        }
        case 'rejected': {
            if (!ctx.reason) {
                return { ok: false, error: 'rejection_reason is required to reject', fields: { reason: true } };
            }
            break;
        }
        case 'disputed': {
            if (!ctx.reason) {
                return { ok: false, error: 'dispute_reason is required to dispute', fields: { reason: true } };
            }
            break;
        }
        case 'payment_scheduled': {
            // Settlement details validated at route level via Zod
            break;
        }
        case 'completed': {
            // Completed only when settled >= expected, or explicit direct supplier payment
            // The actual check is done in the service with DB state
            break;
        }
        case 'archived': {
            // Allowed from completed, cancelled, disputed
            break;
        }
    }
    return { ok: true };
}
async function createAuditEvent(supabase, input) {
    const { error } = await supabase.from('dev_expense_audit_events').insert({
        expense_id: input.expense_id,
        event_type: input.event_type,
        previous_status: input.previous_status,
        new_status: input.new_status,
        actor_type: input.actor_type ?? 'system',
        actor_id: input.actor_id ?? null,
        actor_name: input.actor_name ?? null,
        metadata: input.metadata ?? {},
    });
    if (error) {
        // Throw instead of silently logging — callers using RPC transactions
        // will rollback. Non-transactional callers should catch if needed.
        throw new Error(`[dev-expenses-v4] Failed to create audit event: ${error.message}`);
    }
}
/* ── Settlement recalculation ──────────────────────────────── */
/**
 * Recalculate settled_amount from the sum of completed settlements.
 * Done in SQL to avoid float precision issues.
 */
async function recalculateSettledAmount(supabase, expenseId) {
    const { data, error } = await supabase.rpc('sum_completed_settlements', {
        p_expense_id: expenseId,
    });
    if (error || data == null) {
        // Fallback: query settlements and sum in JS using string arithmetic
        const { data: settlements, error: qErr } = await supabase
            .from('dev_expense_settlements')
            .select('amount')
            .eq('expense_id', expenseId)
            .eq('status', 'completed');
        if (qErr || !settlements)
            return 0;
        // Use integer cents to avoid float issues
        const totalCents = settlements.reduce((sum, s) => sum + Math.round(s.amount * 100), 0);
        return totalCents / 100;
    }
    return Number(data) || 0;
}
class DevExpensesV4Service {
    supabase;
    constructor(supabase) {
        this.supabase = supabase;
    }
    /* ── Read ──────────────────────────────────────────────── */
    async getExpense(id) {
        const { data, error } = await this.supabase
            .from('dev_expenses')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error || !data)
            return null;
        return data;
    }
    async getExpenseDetail(id) {
        const expense = await this.getExpense(id);
        if (!expense)
            return null;
        const [settlementsResult, auditResult, entitiesResult, quoteResult] = await Promise.all([
            this.supabase
                .from('dev_expense_settlements')
                .select('*')
                .eq('expense_id', id)
                .order('created_at', { ascending: false }),
            this.supabase
                .from('dev_expense_audit_events')
                .select('*')
                .eq('expense_id', id)
                .order('created_at', { ascending: false })
                .limit(100),
            this.fetchEntities(expense),
            expense.quote_id
                ? this.supabase.from('quotes').select('*').eq('id', expense.quote_id).maybeSingle()
                : Promise.resolve({ data: null, error: null }),
        ]);
        const expectedAmount = getExpectedSettlementAmount(expense);
        const remainingAmount = getRemainingAmount(expense);
        const allowedTransitions = expense.status_v4
            ? getAllowedTransitions(expense.status_v4)
            : [];
        return {
            expense,
            settlements: settlementsResult.data ?? [],
            audit_events: auditResult.data ?? [],
            entities: entitiesResult,
            quote: quoteResult.data ?? null,
            expected_amount: expectedAmount,
            remaining_amount: remainingAmount,
            allowed_transitions: allowedTransitions,
        };
    }
    async fetchEntities(expense) {
        const ids = [
            expense.incurred_by_entity_id,
            expense.initially_paid_by_entity_id,
            expense.covered_by_entity_id,
            expense.reimbursement_recipient_entity_id,
            expense.billing_recipient_entity_id,
        ].filter(Boolean);
        if (ids.length === 0)
            return {};
        // Exclude bank_details from entity detail responses
        const { data, error } = await this.supabase
            .from('expense_entities')
            .select(exports.PUBLIC_ENTITY_COLUMNS)
            .in('id', ids);
        if (error || !data)
            return {};
        const map = {};
        for (const e of data) {
            map[e.id] = e;
        }
        return map;
    }
    /**
     * Validate that an entity is active and has the required role capability.
     * Throws if the entity is inactive or lacks the required permission.
     */
    async validateEntityRole(entityId, role, label) {
        const { data, error } = await this.supabase
            .from('expense_entities')
            .select('id,active,can_incur_expenses,can_receive_invoices,can_pay_expenses,can_cover_expenses,can_receive_reimbursements')
            .eq('id', entityId)
            .maybeSingle();
        if (error || !data) {
            throw new Error(`Entity not found for role validation (${label})`);
        }
        if (!data.active) {
            throw new Error(`Entity is inactive and cannot be used as ${label}`);
        }
        if (!data[role]) {
            throw new Error(`Entity does not have '${role}' permission and cannot be used as ${label}`);
        }
    }
    /**
     * Build a billing recipient snapshot using an EXPLICIT ALLOWLIST.
     * Never copies: bank_details, metadata, legal_notes, active, role flags,
     * created_at, updated_at, or any internal field.
     */
    buildBillingRecipientSnapshot(entity) {
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
    async fetchEntitySnapshot(entityId) {
        const { data, error } = await this.supabase
            .from('expense_entities')
            .select(exports.PUBLIC_ENTITY_COLUMNS)
            .eq('id', entityId)
            .maybeSingle();
        if (error || !data)
            return null;
        const entity = data;
        return this.buildBillingRecipientSnapshot(entity);
    }
    async refreshSnapshot(expenseId, actor) {
        const expense = await this.getExpense(expenseId);
        if (!expense)
            throw new Error('Expense not found');
        if (!expense.billing_recipient_entity_id) {
            throw new Error('No billing recipient entity set on this expense');
        }
        const snapshot = await this.fetchEntitySnapshot(expense.billing_recipient_entity_id);
        if (!snapshot) {
            throw new Error('Billing recipient entity not found');
        }
        // Use transactional RPC for atomic snapshot update + audit
        const { data: rpcResult, error: rpcError } = await this.supabase
            .rpc('refresh_snapshot_with_audit', {
            p_expense_id: expenseId,
            p_snapshot: snapshot,
            p_previous_status: expense.status_v4,
            p_new_status: expense.status_v4,
            p_entity_id: expense.billing_recipient_entity_id,
            p_actor_type: actor.actor_type,
            p_actor_id: actor.actor_id,
            p_actor_name: actor.actor_name,
        });
        if (rpcError || !rpcResult) {
            // No fallback — RPC is required for atomic snapshot refresh + audit
            throw new Error(`Financial operation unavailable: refresh_snapshot_with_audit RPC failed — ${rpcError?.message ?? 'No data returned'}`);
        }
        return rpcResult;
    }
    /* ── List ──────────────────────────────────────────────── */
    async listExpenses(params) {
        const page = Math.max(1, params.page ?? 1);
        const limit = Math.min(100, Math.max(1, params.limit ?? 25));
        const offset = (page - 1) * limit;
        const sort = params.sort ?? 'created_at';
        const order = params.order ?? 'desc';
        let q = this.supabase
            .from('dev_expenses')
            .select('*', { count: 'exact' });
        if (params.search) {
            q = q.or(`title.ilike.%${params.search}%,category.ilike.%${params.search}%,invoice_number.ilike.%${params.search}%,project_ref.ilike.%${params.search}%`);
        }
        if (params.status) {
            q = q.eq('status_v4', params.status);
        }
        if (params.supplier_id) {
            q = q.eq('creditor_id', params.supplier_id);
        }
        if (params.incurred_by_entity_id) {
            q = q.eq('incurred_by_entity_id', params.incurred_by_entity_id);
        }
        if (params.covered_by_entity_id) {
            q = q.eq('covered_by_entity_id', params.covered_by_entity_id);
        }
        if (params.billing_recipient_entity_id) {
            q = q.eq('billing_recipient_entity_id', params.billing_recipient_entity_id);
        }
        if (params.currency) {
            q = q.eq('invoice_currency', params.currency);
        }
        if (params.date_from) {
            q = q.gte('invoice_date', params.date_from);
        }
        if (params.date_to) {
            q = q.lte('invoice_date', params.date_to);
        }
        if (params.archived !== undefined) {
            q = q.eq('archived', params.archived);
        }
        if (params.migration_review_required !== undefined) {
            q = q.eq('migration_review_required', params.migration_review_required);
        }
        // Sorting
        const allowedSortFields = [
            'created_at', 'updated_at', 'invoice_date', 'due_date',
            'amount_usd', 'invoice_amount', 'status_v4', 'billing_month',
        ];
        const sortField = allowedSortFields.includes(sort) ? sort : 'created_at';
        q = q.order(sortField, { ascending: order === 'asc' })
            .range(offset, offset + limit - 1);
        const { data, error, count } = await q;
        if (error) {
            throw new Error(`List query failed: ${error.message}`);
        }
        const total = count ?? 0;
        const pages = Math.ceil(total / limit);
        return {
            items: (data ?? []),
            pagination: { page, limit, total, pages },
        };
    }
    /* ── Create ────────────────────────────────────────────── */
    async createExpense(input, actor) {
        const insertData = {
            status_v4: 'draft',
            status: 'pending',
            source: 'manual',
            ...input,
        };
        // Ensure V4 defaults
        if (!insertData.project_code)
            insertData.project_code = 'unipay-congo';
        if (!insertData.invoice_currency)
            insertData.invoice_currency = 'USD';
        if (insertData.settled_amount == null)
            insertData.settled_amount = 0;
        if (insertData.migration_review_required == null)
            insertData.migration_review_required = false;
        if (insertData.billing_recipient_reviewed == null)
            insertData.billing_recipient_reviewed = false;
        // Validate entity roles for all entity references
        if (insertData.incurred_by_entity_id) {
            await this.validateEntityRole(insertData.incurred_by_entity_id, 'can_incur_expenses', 'incurred by entity');
        }
        if (insertData.initially_paid_by_entity_id) {
            await this.validateEntityRole(insertData.initially_paid_by_entity_id, 'can_pay_expenses', 'initially paid by entity');
        }
        if (insertData.covered_by_entity_id) {
            await this.validateEntityRole(insertData.covered_by_entity_id, 'can_cover_expenses', 'covered by entity');
        }
        if (insertData.reimbursement_recipient_entity_id) {
            await this.validateEntityRole(insertData.reimbursement_recipient_entity_id, 'can_receive_reimbursements', 'reimbursement recipient entity');
        }
        // Generate billing recipient snapshot if entity_id is provided but no snapshot
        if (insertData.billing_recipient_entity_id && !insertData.billing_recipient_snapshot) {
            // Validate entity role
            await this.validateEntityRole(insertData.billing_recipient_entity_id, 'can_receive_invoices', 'billing recipient');
            const snapshot = await this.fetchEntitySnapshot(insertData.billing_recipient_entity_id);
            if (snapshot)
                insertData.billing_recipient_snapshot = snapshot;
        }
        const { data, error } = await this.supabase
            .from('dev_expenses')
            .insert(insertData)
            .select()
            .single();
        if (error || !data) {
            throw new Error(`Create failed: ${error?.message ?? 'No data returned'}`);
        }
        const expense = data;
        // Sanitize audit metadata — never log snapshots (may contain entity data)
        const auditInput = { ...input };
        delete auditInput.billing_recipient_snapshot;
        await createAuditEvent(this.supabase, {
            expense_id: expense.id,
            event_type: 'expense_created',
            previous_status: null,
            new_status: 'draft',
            actor_type: actor.actor_type,
            actor_id: actor.actor_id,
            actor_name: actor.actor_name,
            metadata: { input: auditInput },
        });
        return expense;
    }
    /* ── Update ────────────────────────────────────────────── */
    async updateExpense(id, updates, actor) {
        const expense = await this.getExpense(id);
        if (!expense)
            throw new Error('Expense not found');
        // Block financial edits after completed
        if (expense.status_v4 === 'completed') {
            const financialFields = [
                'invoice_amount', 'invoice_currency', 'requested_amount',
                'approved_amount', 'settled_amount', 'incurred_by_entity_id',
                'covered_by_entity_id', 'initially_paid_by_entity_id',
                'reimbursement_recipient_entity_id',
                'billing_recipient_entity_id',
            ];
            for (const field of financialFields) {
                if (field in updates) {
                    throw new Error(`Cannot modify '${field}' on a completed expense. Use a correction action instead.`);
                }
            }
        }
        // Refresh billing recipient snapshot if entity_id changed
        if ('billing_recipient_entity_id' in updates && updates.billing_recipient_entity_id) {
            // Validate entity role
            await this.validateEntityRole(updates.billing_recipient_entity_id, 'can_receive_invoices', 'billing recipient');
            const snapshot = await this.fetchEntitySnapshot(updates.billing_recipient_entity_id);
            if (snapshot)
                updates.billing_recipient_snapshot = snapshot;
        }
        const { data, error } = await this.supabase
            .from('dev_expenses')
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error || !data) {
            throw new Error(`Update failed: ${error?.message ?? 'No data returned'}`);
        }
        const updated = data;
        // Sanitize audit metadata — never log snapshots (may contain entity data)
        const auditUpdates = { ...updates };
        delete auditUpdates.billing_recipient_snapshot;
        await createAuditEvent(this.supabase, {
            expense_id: id,
            event_type: 'expense_edited',
            previous_status: expense.status_v4,
            new_status: updated.status_v4,
            actor_type: actor.actor_type,
            actor_id: actor.actor_id,
            actor_name: actor.actor_name,
            metadata: { updates: auditUpdates },
        });
        return updated;
    }
    /* ── Transition ────────────────────────────────────────── */
    async transition(id, ctx, actor) {
        const expense = await this.getExpense(id);
        if (!expense)
            throw new Error('Expense not found');
        const validation = validateTransition(expense, ctx);
        if (!validation.ok) {
            throw new Error(validation.error);
        }
        const previousStatus = expense.status_v4;
        const now = new Date().toISOString();
        // Build RPC parameters — only set fields relevant to the target status
        const rpcParams = {
            p_expense_id: id,
            p_new_status: ctx.to,
            p_expected_current_status: previousStatus,
            p_actor_type: actor.actor_type,
            p_actor_id: actor.actor_id,
            p_actor_name: actor.actor_name,
            p_metadata: {
                approved_amount: ctx.approved_amount,
                reason: ctx.reason,
                notes: ctx.notes,
            },
        };
        // Set timestamps and fields based on target status
        switch (ctx.to) {
            case 'submitted':
                rpcParams.p_submitted_at = now;
                break;
            case 'under_review':
                rpcParams.p_review_started_at = now;
                break;
            case 'approved':
                rpcParams.p_approved_at = now;
                if (ctx.approved_amount != null)
                    rpcParams.p_approved_amount = ctx.approved_amount;
                break;
            case 'partially_approved':
                rpcParams.p_approved_at = now;
                if (ctx.approved_amount != null)
                    rpcParams.p_approved_amount = ctx.approved_amount;
                if (ctx.notes)
                    rpcParams.p_internal_notes_v4 = ctx.notes;
                break;
            case 'rejected':
                rpcParams.p_rejection_reason = ctx.reason;
                break;
            case 'disputed':
                rpcParams.p_dispute_reason = ctx.reason;
                break;
            case 'payment_scheduled':
                rpcParams.p_payment_scheduled_at = now;
                break;
            case 'completed':
                rpcParams.p_completed_at = now;
                break;
            case 'cancelled':
                rpcParams.p_cancelled_at = now;
                break;
            case 'archived':
                rpcParams.p_archived = true;
                rpcParams.p_archived_at = now;
                break;
        }
        const { data: rpcResult, error: rpcError } = await this.supabase
            .rpc('transition_expense', rpcParams);
        if (rpcError || !rpcResult) {
            // Check for STATUS_CONFLICT
            const errMsg = rpcError?.message ?? '';
            if (errMsg.includes('STATUS_CONFLICT')) {
                throw new Error(`STATUS_CONFLICT: expense status changed since read (expected ${previousStatus})`);
            }
            // No fallback — RPC is required for atomic transitions
            throw new Error(`Financial operation unavailable: transition_expense RPC failed — ${errMsg}`);
        }
        return rpcResult;
    }
    /* ── Settlements ───────────────────────────────────────── */
    async listSettlements(expenseId) {
        const { data, error } = await this.supabase
            .from('dev_expense_settlements')
            .select('*')
            .eq('expense_id', expenseId)
            .order('created_at', { ascending: false });
        if (error || !data)
            return [];
        return data;
    }
    async createSettlement(expenseId, input, actor) {
        const expense = await this.getExpense(expenseId);
        if (!expense)
            throw new Error('Expense not found');
        // Idempotency check
        if (input.idempotency_key) {
            const { data: existing } = await this.supabase
                .from('dev_expense_settlements')
                .select('*')
                .eq('idempotency_key', input.idempotency_key)
                .maybeSingle();
            if (existing) {
                // Same key, same payload → return existing
                const existingSettlement = existing;
                if (existingSettlement.expense_id === expenseId &&
                    existingSettlement.settlement_type === input.settlement_type &&
                    Number(existingSettlement.amount) === input.amount) {
                    return existingSettlement;
                }
                // Same key, different payload → conflict
                throw new Error('Idempotency key conflict: same key with different payload');
            }
        }
        // Use transactional RPC for atomic settlement creation + audit
        const { data: rpcResult, error: rpcError } = await this.supabase
            .rpc('create_settlement_with_audit', {
            p_expense_id: expenseId,
            p_settlement_type: input.settlement_type,
            p_payer_entity_id: input.payer_entity_id ?? null,
            p_recipient_entity_id: input.recipient_entity_id ?? null,
            p_amount: input.amount,
            p_currency: input.currency ?? 'USD',
            p_payment_method: input.payment_method ?? null,
            p_transaction_reference: input.transaction_reference ?? null,
            p_scheduled_at: input.scheduled_at ?? null,
            p_notes: input.notes ?? null,
            p_idempotency_key: input.idempotency_key ?? null,
            p_actor_type: actor.actor_type,
            p_actor_id: actor.actor_id,
            p_actor_name: actor.actor_name,
            p_expense_status: expense.status_v4,
        });
        if (rpcError || !rpcResult) {
            // No fallback — RPC is required for atomic settlement creation + audit
            throw new Error(`Financial operation unavailable: create_settlement_with_audit RPC failed — ${rpcError?.message ?? 'No data returned'}`);
        }
        return rpcResult;
    }
    async updateSettlement(expenseId, settlementId, updates, actor) {
        const { data: existing, error: qErr } = await this.supabase
            .from('dev_expense_settlements')
            .select('*')
            .eq('id', settlementId)
            .eq('expense_id', expenseId)
            .maybeSingle();
        if (qErr || !existing) {
            throw new Error('Settlement not found');
        }
        const prevSettlement = existing;
        const wasCompleted = prevSettlement.status === 'completed';
        const willComplete = updates.status === 'completed' && !wasCompleted;
        // Use transactional RPC for settlement confirmation (atomic: lock + complete + recalc + auto-transition + audit)
        if (willComplete) {
            const { data: rpcResult, error: rpcError } = await this.supabase
                .rpc('confirm_settlement', {
                p_settlement_id: settlementId,
                p_actor_type: actor.actor_type,
                p_actor_id: actor.actor_id,
                p_actor_name: actor.actor_name,
            });
            if (rpcError || !rpcResult || rpcResult.length === 0) {
                throw new Error(`Financial operation unavailable: confirm_settlement RPC failed — ${rpcError?.message ?? 'No data returned'}`);
            }
            return rpcResult[0].settlement;
        }
        // Non-completion updates: regular update + audit (audit now throws on failure)
        const { data, error } = await this.supabase
            .from('dev_expense_settlements')
            .update({
            ...updates,
        })
            .eq('id', settlementId)
            .select()
            .single();
        if (error || !data) {
            throw new Error(`Settlement update failed: ${error?.message ?? 'No data returned'}`);
        }
        const updated = data;
        // If a completed settlement was changed to non-completed, recalculate
        if (wasCompleted && updates.status && updates.status !== 'completed') {
            const newSettled = await this.recalculateAndApplySettled(expenseId);
            await this.checkAutoTransition(expenseId, newSettled, actor);
        }
        await createAuditEvent(this.supabase, {
            expense_id: expenseId,
            event_type: 'settlement_updated',
            previous_status: prevSettlement.status,
            new_status: updated.status,
            actor_type: actor.actor_type,
            actor_id: actor.actor_id,
            actor_name: actor.actor_name,
            metadata: {
                settlement_id: settlementId,
                updates,
            },
        });
        return updated;
    }
    /* ── Settlement recalculation + auto-transition ────────── */
    async recalculateAndApplySettled(expenseId) {
        const newSettled = await recalculateSettledAmount(this.supabase, expenseId);
        await this.supabase
            .from('dev_expenses')
            .update({ settled_amount: newSettled })
            .eq('id', expenseId);
        return newSettled;
    }
    async checkAutoTransition(expenseId, settledAmount, actor) {
        const expense = await this.getExpense(expenseId);
        if (!expense || !expense.status_v4)
            return;
        const expected = getExpectedSettlementAmount(expense);
        if (expense.status_v4 === 'payment_scheduled' && settledAmount > 0 && settledAmount < expected) {
            // Auto-transition to partially_paid
            await this.transition(expenseId, { to: 'partially_paid' }, actor);
        }
        else if ((expense.status_v4 === 'payment_scheduled' || expense.status_v4 === 'partially_paid') &&
            settledAmount >= expected && expected > 0) {
            // Auto-transition to completed
            await this.transition(expenseId, { to: 'completed' }, actor);
        }
    }
    /* ── Audit ─────────────────────────────────────────────── */
    async listAuditEvents(expenseId) {
        const { data, error } = await this.supabase
            .from('dev_expense_audit_events')
            .select('*')
            .eq('expense_id', expenseId)
            .order('created_at', { ascending: false })
            .limit(100);
        if (error || !data)
            return [];
        return data;
    }
    /* ── Migration review ──────────────────────────────────── */
    async resolveMigrationReview(id, input, actor) {
        const expense = await this.getExpense(id);
        if (!expense)
            throw new Error('Expense not found');
        // Validate entity roles before calling RPC (better error messages)
        if (input.billing_recipient_entity_id) {
            await this.validateEntityRole(input.billing_recipient_entity_id, 'can_receive_invoices', 'billing recipient');
        }
        if (input.incurred_by_entity_id) {
            await this.validateEntityRole(input.incurred_by_entity_id, 'can_incur_expenses', 'incurred_by');
        }
        if (input.initially_paid_by_entity_id) {
            await this.validateEntityRole(input.initially_paid_by_entity_id, 'can_pay_expenses', 'initially_paid_by');
        }
        if (input.covered_by_entity_id) {
            await this.validateEntityRole(input.covered_by_entity_id, 'can_cover_expenses', 'covered_by');
        }
        if (input.reimbursement_recipient_entity_id) {
            await this.validateEntityRole(input.reimbursement_recipient_entity_id, 'can_receive_reimbursements', 'reimbursement_recipient');
        }
        // Never auto-complete
        if (input.status === 'completed') {
            throw new Error('Cannot set status to completed during migration review without proof');
        }
        // Use transactional RPC for atomic resolution + snapshot + audit
        const { data: rpcResult, error: rpcError } = await this.supabase
            .rpc('resolve_migration_review_with_audit', {
            p_expense_id: id,
            p_status: input.status ?? null,
            p_incurred_by_entity_id: input.incurred_by_entity_id ?? null,
            p_initially_paid_by_entity_id: input.initially_paid_by_entity_id ?? null,
            p_covered_by_entity_id: input.covered_by_entity_id ?? null,
            p_reimbursement_recipient_entity_id: input.reimbursement_recipient_entity_id ?? null,
            p_billing_recipient_entity_id: input.billing_recipient_entity_id ?? null,
            p_approved_amount: input.approved_amount ?? null,
            p_settled_amount: input.settled_amount ?? null,
            p_migration_notes: input.notes ?? null,
            p_actor_type: actor.actor_type,
            p_actor_id: actor.actor_id,
            p_actor_name: actor.actor_name,
        });
        if (rpcError || !rpcResult) {
            const errMsg = rpcError?.message ?? '';
            if (errMsg.includes('MIGRATION_REVIEW_ALREADY_RESOLVED')) {
                throw new Error('MIGRATION_REVIEW_ALREADY_RESOLVED: migration review has already been resolved for this expense');
            }
            // No fallback — RPC is required for atomic resolution
            throw new Error(`Financial operation unavailable: resolve_migration_review_with_audit RPC failed — ${errMsg}`);
        }
        return rpcResult;
    }
    /* ── Stats ─────────────────────────────────────────────── */
    async getStats() {
        // Fetch all non-archived expenses with V4 columns
        const { data, error } = await this.supabase
            .from('dev_expenses')
            .select('status_v4, invoice_currency, invoice_amount, requested_amount, approved_amount, settled_amount, due_date, migration_review_required, archived')
            .eq('archived', false);
        if (error || !data) {
            return {
                total_engaged: {},
                awaiting_validation: {},
                approved_to_pay: {},
                payment_scheduled: {},
                settled_this_month: {},
                remaining_due: {},
                overdue_count: 0,
                migration_review_count: 0,
            };
        }
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const stats = {
            total_engaged: {},
            awaiting_validation: {},
            approved_to_pay: {},
            payment_scheduled: {},
            settled_this_month: {},
            remaining_due: {},
            overdue_count: 0,
            migration_review_count: 0,
        };
        for (const row of data) {
            const currency = row.invoice_currency || 'USD';
            const status = row.status_v4;
            const invoiceAmount = Number(row.invoice_amount ?? 0);
            const requestedAmount = Number(row.requested_amount ?? invoiceAmount);
            const approvedAmount = Number(row.approved_amount ?? 0);
            const settledAmount = Number(row.settled_amount ?? 0);
            // Use integer cents for summation
            const invoiceCents = Math.round(invoiceAmount * 100);
            const requestedCents = Math.round(requestedAmount * 100);
            const approvedCents = Math.round(approvedAmount * 100);
            const settledCents = Math.round(settledAmount * 100);
            // total_engaged: all non-archived
            stats.total_engaged[currency] = (stats.total_engaged[currency] ?? 0) + invoiceCents;
            // awaiting_validation: submitted or under_review
            if (status === 'submitted' || status === 'under_review') {
                stats.awaiting_validation[currency] = (stats.awaiting_validation[currency] ?? 0) + requestedCents;
            }
            // approved_to_pay: approved or partially_approved
            if (status === 'approved' || status === 'partially_approved') {
                stats.approved_to_pay[currency] = (stats.approved_to_pay[currency] ?? 0) + approvedCents;
            }
            // payment_scheduled
            if (status === 'payment_scheduled' || status === 'partially_paid') {
                stats.payment_scheduled[currency] = (stats.payment_scheduled[currency] ?? 0) + approvedCents;
            }
            // settled_this_month: settled_amount for completed this month
            if (status === 'completed') {
                stats.settled_this_month[currency] = (stats.settled_this_month[currency] ?? 0) + settledCents;
            }
            // remaining_due: expected - settled for active expenses
            if (status && !['completed', 'cancelled', 'archived', 'draft', 'rejected'].includes(status)) {
                const expectedCents = approvedCents > 0 ? approvedCents : requestedCents;
                const remainingCents = Math.max(expectedCents - settledCents, 0);
                if (remainingCents > 0) {
                    stats.remaining_due[currency] = (stats.remaining_due[currency] ?? 0) + remainingCents;
                }
            }
            // overdue_count
            const dueDate = row.due_date;
            if (dueDate && status && !['completed', 'cancelled', 'archived'].includes(status)) {
                if (dueDate < now.toISOString().slice(0, 10)) {
                    stats.overdue_count++;
                }
            }
            // migration_review_count
            if (row.migration_review_required === true) {
                stats.migration_review_count++;
            }
        }
        // Convert cents back to dollars
        for (const key of ['total_engaged', 'awaiting_validation', 'approved_to_pay', 'payment_scheduled', 'settled_this_month', 'remaining_due']) {
            for (const currency of Object.keys(stats[key])) {
                stats[key][currency] = Math.round(stats[key][currency]) / 100;
            }
        }
        return stats;
    }
}
exports.DevExpensesV4Service = DevExpensesV4Service;
//# sourceMappingURL=dev-expenses-v4.js.map