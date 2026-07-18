/**
 * Admin routes — Dev Expenses V4
 *
 * GET    /v1/admin/dev-expenses-v4                       — paginated list with filters
 * POST   /v1/admin/dev-expenses-v4                       — create expense
 * GET    /v1/admin/dev-expenses-v4/:id                   — detail with settlements, audit, entities
 * PATCH  /v1/admin/dev-expenses-v4/:id                   — update expense
 * POST   /v1/admin/dev-expenses-v4/:id/transition         — state machine transition
 * GET    /v1/admin/dev-expenses-v4/:id/settlements        — list settlements
 * POST   /v1/admin/dev-expenses-v4/:id/settlements        — create settlement
 * PATCH  /v1/admin/dev-expenses-v4/:id/settlements/:sid   — update settlement
 * GET    /v1/admin/dev-expenses-v4/:id/audit              — audit trail
 * GET    /v1/admin/dev-expenses-v4/stats                  — statistics grouped by currency
 * POST   /v1/admin/dev-expenses-v4/:id/resolve-migration-review — resolve migration review
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DevExpensesV4Service,
  canTransition,
  getAllowedTransitions,
  getExpectedSettlementAmount,
  getRemainingAmount,
  type DevExpenseStatusV4,
  type ActorInfo,
} from '../../services/dev-expenses-v4';

/* ── Validation patterns ──────────────────────────────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;

const STATUS_V4_VALUES = [
  'draft', 'submitted', 'under_review', 'approved', 'partially_approved',
  'rejected', 'payment_scheduled', 'partially_paid', 'completed',
  'disputed', 'cancelled', 'archived',
] as const;

const SETTLEMENT_TYPE_VALUES = [
  'supplier_payment', 'reimbursement', 'partial_reimbursement',
  'internal_offset', 'adjustment', 'other',
] as const;

const SETTLEMENT_STATUS_VALUES = [
  'scheduled', 'processing', 'completed', 'failed', 'cancelled',
] as const;

/* ── Zod schemas ──────────────────────────────────────────── */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  status: z.enum(STATUS_V4_VALUES).optional(),
  supplier_id: z.string().uuid().optional(),
  incurred_by_entity_id: z.string().uuid().optional(),
  covered_by_entity_id: z.string().uuid().optional(),
  currency: z.string().max(10).optional(),
  date_from: z.string().regex(DATE_RE).optional(),
  date_to: z.string().regex(DATE_RE).optional(),
  archived: z.coerce.boolean().optional(),
  migration_review_required: z.coerce.boolean().optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const createSchema = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().min(1).max(200),
  creditor_id: z.string().uuid().optional(),
  billing_month: z.string().regex(MONTH_RE),
  project_code: z.string().max(100).optional(),
  project_ref: z.string().max(200).optional(),
  quote_id: z.string().uuid().optional(),
  invoice_number: z.string().max(100).optional(),
  invoice_date: z.string().regex(DATE_RE).optional(),
  due_date: z.string().regex(DATE_RE).optional(),
  incurred_by_entity_id: z.string().uuid().optional(),
  initially_paid_by_entity_id: z.string().uuid().optional(),
  covered_by_entity_id: z.string().uuid().optional(),
  reimbursement_recipient_entity_id: z.string().uuid().optional(),
  invoice_amount: z.number().min(0).max(99_999_999.99).optional(),
  invoice_currency: z.string().max(10).default('USD'),
  requested_amount: z.number().min(0).max(99_999_999.99).optional(),
  approved_amount: z.number().min(0).max(99_999_999.99).optional(),
  initial_payment_status: z.enum(['unpaid', 'paid_by_incurred_entity', 'paid_by_covering_entity', 'paid_by_third_party', 'unknown']).optional(),
  initial_payment_method: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
  amount_usd: z.number().min(0).max(99_999_999.99).optional(),
}).strict();

const patchSchema = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
  project_code: z.string().max(100).optional(),
  project_ref: z.string().max(200).optional(),
  quote_id: z.string().uuid().nullable().optional(),
  invoice_number: z.string().max(100).optional(),
  invoice_date: z.string().regex(DATE_RE).nullable().optional(),
  due_date: z.string().regex(DATE_RE).nullable().optional(),
  incurred_by_entity_id: z.string().uuid().nullable().optional(),
  initially_paid_by_entity_id: z.string().uuid().nullable().optional(),
  covered_by_entity_id: z.string().uuid().nullable().optional(),
  reimbursement_recipient_entity_id: z.string().uuid().nullable().optional(),
  invoice_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  invoice_currency: z.string().max(10).optional(),
  requested_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  approved_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  initial_payment_status: z.enum(['unpaid', 'paid_by_incurred_entity', 'paid_by_covering_entity', 'paid_by_third_party', 'unknown']).nullable().optional(),
  initial_payment_method: z.string().max(50).nullable().optional(),
  internal_notes_v4: z.string().max(2000).nullable().optional(),
  rejection_reason: z.string().max(1000).nullable().optional(),
  dispute_reason: z.string().max(1000).nullable().optional(),
}).strict();

const transitionSchema = z.object({
  to: z.enum(STATUS_V4_VALUES),
  approved_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  approved_equals_requested: z.boolean().optional(),
}).strict();

const createSettlementSchema = z.object({
  settlement_type: z.enum(SETTLEMENT_TYPE_VALUES),
  payer_entity_id: z.string().uuid().nullable().optional(),
  recipient_entity_id: z.string().uuid().nullable().optional(),
  amount: z.number().positive().max(99_999_999.99),
  currency: z.string().max(10).default('USD'),
  payment_method: z.string().max(50).nullable().optional(),
  transaction_reference: z.string().max(200).nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().max(200).nullable().optional(),
}).strict();

const patchSettlementSchema = z.object({
  status: z.enum(SETTLEMENT_STATUS_VALUES).optional(),
  payment_method: z.string().max(50).nullable().optional(),
  transaction_reference: z.string().max(200).nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  executed_at: z.string().datetime().nullable().optional(),
  confirmed_at: z.string().datetime().nullable().optional(),
  proof_file_url: z.string().max(500).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
}).strict();

const migrationReviewSchema = z.object({
  status: z.enum(STATUS_V4_VALUES).optional(),
  incurred_by_entity_id: z.string().uuid().nullable().optional(),
  initially_paid_by_entity_id: z.string().uuid().nullable().optional(),
  covered_by_entity_id: z.string().uuid().nullable().optional(),
  reimbursement_recipient_entity_id: z.string().uuid().nullable().optional(),
  approved_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  settled_amount: z.number().min(0).max(99_999_999.99).nullable().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

/* ── Helpers ──────────────────────────────────────────────── */

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

function getActor(request: FastifyRequest): ActorInfo {
  return {
    actor_type: 'admin',
    actor_id: request.operatorId || 'admin',
    actor_name: null,
  };
}

function handleError(reply: FastifyReply, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('not found')) {
    reply.status(404).send({ error: msg, statusCode: 404 });
  } else if (msg.includes('Idempotency key conflict')) {
    reply.status(409).send({ error: msg, statusCode: 409 });
  } else if (msg.includes('Cannot') || msg.includes('required') || msg.includes('must be') || msg.includes('Transition') || msg.includes('already')) {
    reply.status(400).send({ error: msg, statusCode: 400 });
  } else {
    reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
  }
}

/* ── Route plugin ─────────────────────────────────────────── */

const adminDevExpensesV4Route: FastifyPluginAsync = async (fastify) => {

  /* ── GET /admin/dev-expenses-v4/stats ──────────────────── */
  fastify.get('/admin/dev-expenses-v4/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const stats = await service.getStats();
      return stats;
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── GET /admin/dev-expenses-v4 ────────────────────────── */
  fastify.get('/admin/dev-expenses-v4', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = listSchema.safeParse(request.query);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      return await service.listExpenses(parse.data);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── POST /admin/dev-expenses-v4 ───────────────────────── */
  fastify.post('/admin/dev-expenses-v4', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = createSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const expense = await service.createExpense(parse.data, getActor(request));
      return reply.status(201).send({ expense });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── GET /admin/dev-expenses-v4/:id ────────────────────── */
  fastify.get<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const detail = await service.getExpenseDetail(request.params.id);
      if (!detail) return reply.status(404).send({ error: 'Expense not found' });
      return detail;
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── PATCH /admin/dev-expenses-v4/:id ──────────────────── */
  fastify.patch<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    const parse = patchSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const expense = await service.updateExpense(request.params.id, parse.data, getActor(request));
      return { expense };
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── POST /admin/dev-expenses-v4/:id/transition ────────── */
  fastify.post<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id/transition', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    const parse = transitionSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const expense = await service.transition(
        request.params.id,
        {
          to: parse.data.to,
          approved_amount: parse.data.approved_amount,
          reason: parse.data.reason,
          notes: parse.data.notes,
          approved_equals_requested: parse.data.approved_equals_requested,
        },
        getActor(request),
      );
      return { expense };
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── GET /admin/dev-expenses-v4/:id/settlements ────────── */
  fastify.get<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id/settlements', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const settlements = await service.listSettlements(request.params.id);
      return { items: settlements };
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── POST /admin/dev-expenses-v4/:id/settlements ───────── */
  fastify.post<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id/settlements', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    const parse = createSettlementSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const settlement = await service.createSettlement(
        request.params.id,
        parse.data,
        getActor(request),
      );
      return reply.status(201).send({ settlement });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── PATCH /admin/dev-expenses-v4/:id/settlements/:sid ─── */
  fastify.patch<{ Params: { id: string; sid: string } }>('/admin/dev-expenses-v4/:id/settlements/:sid', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }
    if (!UUID_RE.test(request.params.sid)) {
      return reply.status(400).send({ error: 'Invalid settlement id (expected UUID)' });
    }

    const parse = patchSettlementSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const settlement = await service.updateSettlement(
        request.params.id,
        request.params.sid,
        parse.data,
        getActor(request),
      );
      return { settlement };
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── GET /admin/dev-expenses-v4/:id/audit ──────────────── */
  fastify.get<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id/audit', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const events = await service.listAuditEvents(request.params.id);
      return { items: events };
    } catch (err) {
      return handleError(reply, err);
    }
  });

  /* ── POST /admin/dev-expenses-v4/:id/resolve-migration-review ─ */
  fastify.post<{ Params: { id: string } }>('/admin/dev-expenses-v4/:id/resolve-migration-review', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid expense id (expected UUID)' });
    }

    const parse = migrationReviewSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    try {
      const service = new DevExpensesV4Service(fastify.supabase);
      const expense = await service.resolveMigrationReview(
        request.params.id,
        parse.data,
        getActor(request),
      );
      return { expense };
    } catch (err) {
      return handleError(reply, err);
    }
  });
};

export default adminDevExpensesV4Route;
