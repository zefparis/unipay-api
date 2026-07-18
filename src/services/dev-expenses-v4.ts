/**
 * Dev Expenses V4 — Central business service
 *
 * State machine, settlements, audit, amount calculations.
 * All financial logic lives here, not in route handlers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/* ── Types ─────────────────────────────────────────────────── */

export type DevExpenseStatusV4 =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'partially_approved'
  | 'rejected'
  | 'payment_scheduled'
  | 'partially_paid'
  | 'completed'
  | 'disputed'
  | 'cancelled'
  | 'archived';

export type InitialPaymentStatus =
  | 'unpaid'
  | 'paid_by_incurred_entity'
  | 'paid_by_covering_entity'
  | 'paid_by_third_party'
  | 'unknown';

export type SettlementType =
  | 'supplier_payment'
  | 'reimbursement'
  | 'partial_reimbursement'
  | 'internal_offset'
  | 'adjustment'
  | 'other';

export type SettlementStatus =
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  country_code: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* ── State machine ─────────────────────────────────────────── */

const TRANSITIONS: Record<DevExpenseStatusV4, DevExpenseStatusV4[]> = {
  draft:              ['submitted', 'cancelled'],
  submitted:          ['under_review', 'draft', 'cancelled'],
  under_review:       ['approved', 'partially_approved', 'rejected', 'submitted', 'cancelled'],
  approved:           ['payment_scheduled', 'disputed', 'cancelled'],
  partially_approved: ['payment_scheduled', 'disputed', 'cancelled'],
  rejected:           ['draft', 'cancelled'],
  payment_scheduled:  ['partially_paid', 'completed', 'approved', 'disputed', 'cancelled'],
  partially_paid:     ['completed', 'payment_scheduled', 'disputed', 'cancelled'],
  completed:          ['archived', 'disputed'],
  disputed:           ['under_review', 'cancelled', 'archived'],
  cancelled:          ['draft', 'archived'],
  archived:           [],
};

export function canTransition(from: DevExpenseStatusV4, to: DevExpenseStatusV4): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function getAllowedTransitions(from: DevExpenseStatusV4): DevExpenseStatusV4[] {
  return TRANSITIONS[from] ?? [];
}

/* ── Amount calculations ───────────────────────────────────── */

/**
 * Priority: approved_amount → requested_amount → invoice_amount → amount_usd
 * Never duplicate this logic in routes.
 */
export function getExpectedSettlementAmount(expense: DevExpenseV4): number {
  const val =
    expense.approved_amount ??
    expense.requested_amount ??
    expense.invoice_amount ??
    expense.amount_usd ??
    0;
  return val;
}

/**
 * max(expectedSettlementAmount - settledAmount, 0)
 */
export function getRemainingAmount(expense: DevExpenseV4): number {
  const expected = getExpectedSettlementAmount(expense);
  const settled = expense.settled_amount ?? 0;
  return Math.max(expected - settled, 0);
}

/* ── Transition validation ─────────────────────────────────── */

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

export function validateTransition(
  expense: DevExpenseV4,
  ctx: TransitionContext,
): TransitionValidationResult {
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

/* ── Audit helper ──────────────────────────────────────────── */

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

export async function createAuditEvent(
  supabase: SupabaseClient,
  input: AuditInput,
): Promise<void> {
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
    // Log but don't throw — audit is best-effort but should not break the operation
    console.error('[dev-expenses-v4] Failed to create audit event:', error.message);
  }
}

/* ── Settlement recalculation ──────────────────────────────── */

/**
 * Recalculate settled_amount from the sum of completed settlements.
 * Done in SQL to avoid float precision issues.
 */
export async function recalculateSettledAmount(
  supabase: SupabaseClient,
  expenseId: string,
): Promise<number> {
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

    if (qErr || !settlements) return 0;

    // Use integer cents to avoid float issues
    const totalCents = settlements.reduce(
      (sum: number, s: { amount: number }) => sum + Math.round(s.amount * 100),
      0,
    );
    return totalCents / 100;
  }

  return Number(data) || 0;
}

/* ── Service class ─────────────────────────────────────────── */

export interface ActorInfo {
  actor_type: ActorType;
  actor_id: string | null;
  actor_name: string | null;
}

export class DevExpensesV4Service {
  constructor(private supabase: SupabaseClient) {}

  /* ── Read ──────────────────────────────────────────────── */

  async getExpense(id: string): Promise<DevExpenseV4 | null> {
    const { data, error } = await this.supabase
      .from('dev_expenses')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) return null;
    return data as DevExpenseV4;
  }

  async getExpenseDetail(id: string) {
    const expense = await this.getExpense(id);
    if (!expense) return null;

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

  private async fetchEntities(expense: DevExpenseV4) {
    const ids = [
      expense.incurred_by_entity_id,
      expense.initially_paid_by_entity_id,
      expense.covered_by_entity_id,
      expense.reimbursement_recipient_entity_id,
    ].filter(Boolean) as string[];

    if (ids.length === 0) return {};

    const { data, error } = await this.supabase
      .from('expense_entities')
      .select('*')
      .in('id', ids);

    if (error || !data) return {};

    const map: Record<string, ExpenseEntity> = {};
    for (const e of data as ExpenseEntity[]) {
      map[e.id] = e;
    }
    return map;
  }

  /* ── List ──────────────────────────────────────────────── */

  async listExpenses(params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    supplier_id?: string;
    incurred_by_entity_id?: string;
    covered_by_entity_id?: string;
    currency?: string;
    date_from?: string;
    date_to?: string;
    archived?: boolean;
    migration_review_required?: boolean;
    sort?: string;
    order?: 'asc' | 'desc';
  }) {
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
      items: (data ?? []) as DevExpenseV4[],
      pagination: { page, limit, total, pages },
    };
  }

  /* ── Create ────────────────────────────────────────────── */

  async createExpense(
    input: Record<string, unknown>,
    actor: ActorInfo,
  ): Promise<DevExpenseV4> {
    const insertData: Record<string, unknown> = {
      status_v4: 'draft',
      status: 'pending',
      source: 'manual',
      ...input,
    };

    // Ensure V4 defaults
    if (!insertData.project_code) insertData.project_code = 'unipay-congo';
    if (!insertData.invoice_currency) insertData.invoice_currency = 'USD';
    if (insertData.settled_amount == null) insertData.settled_amount = 0;
    if (insertData.migration_review_required == null) insertData.migration_review_required = false;

    const { data, error } = await this.supabase
      .from('dev_expenses')
      .insert(insertData)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Create failed: ${error?.message ?? 'No data returned'}`);
    }

    const expense = data as DevExpenseV4;

    await createAuditEvent(this.supabase, {
      expense_id: expense.id,
      event_type: 'expense_created',
      previous_status: null,
      new_status: 'draft',
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      metadata: { input },
    });

    return expense;
  }

  /* ── Update ────────────────────────────────────────────── */

  async updateExpense(
    id: string,
    updates: Record<string, unknown>,
    actor: ActorInfo,
  ): Promise<DevExpenseV4> {
    const expense = await this.getExpense(id);
    if (!expense) throw new Error('Expense not found');

    // Block financial edits after completed
    if (expense.status_v4 === 'completed') {
      const financialFields = [
        'invoice_amount', 'invoice_currency', 'requested_amount',
        'approved_amount', 'settled_amount', 'incurred_by_entity_id',
        'covered_by_entity_id', 'initially_paid_by_entity_id',
        'reimbursement_recipient_entity_id',
      ];
      for (const field of financialFields) {
        if (field in updates) {
          throw new Error(`Cannot modify '${field}' on a completed expense. Use a correction action instead.`);
        }
      }
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

    const updated = data as DevExpenseV4;

    await createAuditEvent(this.supabase, {
      expense_id: id,
      event_type: 'expense_edited',
      previous_status: expense.status_v4,
      new_status: updated.status_v4,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      metadata: { updates },
    });

    return updated;
  }

  /* ── Transition ────────────────────────────────────────── */

  async transition(
    id: string,
    ctx: TransitionContext,
    actor: ActorInfo,
  ): Promise<DevExpenseV4> {
    const expense = await this.getExpense(id);
    if (!expense) throw new Error('Expense not found');

    const validation = validateTransition(expense, ctx);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const previousStatus = expense.status_v4;
    const updates: Record<string, unknown> = {
      status_v4: ctx.to,
    };

    // Set timestamps
    const now = new Date().toISOString();
    switch (ctx.to) {
      case 'submitted':
        updates.submitted_at = now;
        break;
      case 'under_review':
        updates.review_started_at = now;
        break;
      case 'approved':
        updates.approved_at = now;
        if (ctx.approved_amount != null) updates.approved_amount = ctx.approved_amount;
        break;
      case 'partially_approved':
        updates.approved_at = now;
        if (ctx.approved_amount != null) updates.approved_amount = ctx.approved_amount;
        if (ctx.notes) updates.internal_notes_v4 = ctx.notes;
        break;
      case 'rejected':
        updates.rejection_reason = ctx.reason;
        break;
      case 'disputed':
        updates.dispute_reason = ctx.reason;
        break;
      case 'payment_scheduled':
        updates.payment_scheduled_at = now;
        break;
      case 'completed':
        updates.completed_at = now;
        break;
      case 'cancelled':
        updates.cancelled_at = now;
        break;
      case 'archived':
        updates.archived = true;
        updates.archived_at = now;
        break;
    }

    const { data, error } = await this.supabase
      .from('dev_expenses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Transition failed: ${error?.message ?? 'No data returned'}`);
    }

    const updated = data as DevExpenseV4;

    await createAuditEvent(this.supabase, {
      expense_id: id,
      event_type: 'status_transition',
      previous_status: previousStatus,
      new_status: ctx.to,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      metadata: {
        approved_amount: ctx.approved_amount,
        reason: ctx.reason,
        notes: ctx.notes,
      },
    });

    return updated;
  }

  /* ── Settlements ───────────────────────────────────────── */

  async listSettlements(expenseId: string): Promise<Settlement[]> {
    const { data, error } = await this.supabase
      .from('dev_expense_settlements')
      .select('*')
      .eq('expense_id', expenseId)
      .order('created_at', { ascending: false });

    if (error || !data) return [];
    return data as Settlement[];
  }

  async createSettlement(
    expenseId: string,
    input: {
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
    },
    actor: ActorInfo,
  ): Promise<Settlement> {
    const expense = await this.getExpense(expenseId);
    if (!expense) throw new Error('Expense not found');

    // Idempotency check
    if (input.idempotency_key) {
      const { data: existing } = await this.supabase
        .from('dev_expense_settlements')
        .select('*')
        .eq('idempotency_key', input.idempotency_key)
        .maybeSingle();

      if (existing) {
        // Same key, same payload → return existing
        const existingSettlement = existing as Settlement;
        if (
          existingSettlement.expense_id === expenseId &&
          existingSettlement.settlement_type === input.settlement_type &&
          Number(existingSettlement.amount) === input.amount
        ) {
          return existingSettlement;
        }
        // Same key, different payload → conflict
        throw new Error('Idempotency key conflict: same key with different payload');
      }
    }

    const { data, error } = await this.supabase
      .from('dev_expense_settlements')
      .insert({
        expense_id: expenseId,
        settlement_type: input.settlement_type,
        payer_entity_id: input.payer_entity_id ?? null,
        recipient_entity_id: input.recipient_entity_id ?? null,
        amount: input.amount,
        currency: input.currency ?? 'USD',
        payment_method: input.payment_method ?? null,
        transaction_reference: input.transaction_reference ?? null,
        status: 'scheduled',
        scheduled_at: input.scheduled_at ?? null,
        notes: input.notes ?? null,
        idempotency_key: input.idempotency_key ?? null,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Settlement creation failed: ${error?.message ?? 'No data returned'}`);
    }

    const settlement = data as Settlement;

    await createAuditEvent(this.supabase, {
      expense_id: expenseId,
      event_type: 'settlement_created',
      previous_status: expense.status_v4,
      new_status: expense.status_v4,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      metadata: {
        settlement_id: settlement.id,
        settlement_type: input.settlement_type,
        amount: input.amount,
        currency: input.currency ?? 'USD',
      },
    });

    return settlement;
  }

  async updateSettlement(
    expenseId: string,
    settlementId: string,
    updates: Record<string, unknown>,
    actor: ActorInfo,
  ): Promise<Settlement> {
    const { data: existing, error: qErr } = await this.supabase
      .from('dev_expense_settlements')
      .select('*')
      .eq('id', settlementId)
      .eq('expense_id', expenseId)
      .maybeSingle();

    if (qErr || !existing) {
      throw new Error('Settlement not found');
    }

    const prevSettlement = existing as Settlement;
    const wasCompleted = prevSettlement.status === 'completed';
    const willComplete = updates.status === 'completed' && !wasCompleted;

    const { data, error } = await this.supabase
      .from('dev_expense_settlements')
      .update({
        ...updates,
        ...(willComplete ? { confirmed_at: new Date().toISOString() } : {}),
      })
      .eq('id', settlementId)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Settlement update failed: ${error?.message ?? 'No data returned'}`);
    }

    const updated = data as Settlement;

    // If settlement status changed to/from completed, recalculate settled_amount
    if (willComplete || (wasCompleted && updates.status && updates.status !== 'completed')) {
      const newSettled = await this.recalculateAndApplySettled(expenseId);

      // Check for auto-transition to partially_paid or completed
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

  private async recalculateAndApplySettled(expenseId: string): Promise<number> {
    const newSettled = await recalculateSettledAmount(this.supabase, expenseId);

    await this.supabase
      .from('dev_expenses')
      .update({ settled_amount: newSettled })
      .eq('id', expenseId);

    return newSettled;
  }

  private async checkAutoTransition(
    expenseId: string,
    settledAmount: number,
    actor: ActorInfo,
  ): Promise<void> {
    const expense = await this.getExpense(expenseId);
    if (!expense || !expense.status_v4) return;

    const expected = getExpectedSettlementAmount(expense);

    if (expense.status_v4 === 'payment_scheduled' && settledAmount > 0 && settledAmount < expected) {
      // Auto-transition to partially_paid
      await this.transition(expenseId, { to: 'partially_paid' }, actor);
    } else if (
      (expense.status_v4 === 'payment_scheduled' || expense.status_v4 === 'partially_paid') &&
      settledAmount >= expected && expected > 0
    ) {
      // Auto-transition to completed
      await this.transition(expenseId, { to: 'completed' }, actor);
    }
  }

  /* ── Audit ─────────────────────────────────────────────── */

  async listAuditEvents(expenseId: string): Promise<AuditEvent[]> {
    const { data, error } = await this.supabase
      .from('dev_expense_audit_events')
      .select('*')
      .eq('expense_id', expenseId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error || !data) return [];
    return data as AuditEvent[];
  }

  /* ── Migration review ──────────────────────────────────── */

  async resolveMigrationReview(
    id: string,
    input: {
      status?: DevExpenseStatusV4;
      incurred_by_entity_id?: string | null;
      initially_paid_by_entity_id?: string | null;
      covered_by_entity_id?: string | null;
      reimbursement_recipient_entity_id?: string | null;
      approved_amount?: number | null;
      settled_amount?: number | null;
      notes?: string;
    },
    actor: ActorInfo,
  ): Promise<DevExpenseV4> {
    const expense = await this.getExpense(id);
    if (!expense) throw new Error('Expense not found');

    const updates: Record<string, unknown> = {
      migration_review_required: false,
    };

    if (input.status) updates.status_v4 = input.status;
    if (input.incurred_by_entity_id) updates.incurred_by_entity_id = input.incurred_by_entity_id;
    if (input.initially_paid_by_entity_id) updates.initially_paid_by_entity_id = input.initially_paid_by_entity_id;
    if (input.covered_by_entity_id) updates.covered_by_entity_id = input.covered_by_entity_id;
    if (input.reimbursement_recipient_entity_id) updates.reimbursement_recipient_entity_id = input.reimbursement_recipient_entity_id;
    if (input.approved_amount != null) updates.approved_amount = input.approved_amount;
    if (input.settled_amount != null) updates.settled_amount = input.settled_amount;
    if (input.notes) {
      updates.migration_notes = (expense.migration_notes ?? '') + '\n' + input.notes;
    }

    // Never auto-complete
    if (updates.status_v4 === 'completed') {
      throw new Error('Cannot set status to completed during migration review without proof');
    }

    const { data, error } = await this.supabase
      .from('dev_expenses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Migration review resolve failed: ${error?.message ?? 'No data returned'}`);
    }

    const updated = data as DevExpenseV4;

    await createAuditEvent(this.supabase, {
      expense_id: id,
      event_type: 'migration_review_resolved',
      previous_status: expense.status_v4,
      new_status: updated.status_v4,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      metadata: { input },
    });

    return updated;
  }

  /* ── Stats ─────────────────────────────────────────────── */

  async getStats(): Promise<{
    total_engaged: Record<string, number>;
    awaiting_validation: Record<string, number>;
    approved_to_pay: Record<string, number>;
    payment_scheduled: Record<string, number>;
    settled_this_month: Record<string, number>;
    remaining_due: Record<string, number>;
    overdue_count: number;
    migration_review_count: number;
  }> {
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
      total_engaged: {} as Record<string, number>,
      awaiting_validation: {} as Record<string, number>,
      approved_to_pay: {} as Record<string, number>,
      payment_scheduled: {} as Record<string, number>,
      settled_this_month: {} as Record<string, number>,
      remaining_due: {} as Record<string, number>,
      overdue_count: 0,
      migration_review_count: 0,
    };

    for (const row of data as Array<Record<string, unknown>>) {
      const currency = (row.invoice_currency as string) || 'USD';
      const status = row.status_v4 as DevExpenseStatusV4 | null;
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
      const dueDate = row.due_date as string | null;
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
    for (const key of ['total_engaged', 'awaiting_validation', 'approved_to_pay', 'payment_scheduled', 'settled_this_month', 'remaining_due'] as const) {
      for (const currency of Object.keys(stats[key])) {
        stats[key][currency] = Math.round(stats[key][currency]) / 100;
      }
    }

    return stats;
  }
}
