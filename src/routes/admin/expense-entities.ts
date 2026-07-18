/**
 * Admin routes — Expense Entities (V4)
 *
 * GET    /v1/admin/expense-entities       — list (filterable: active, entity_type)
 * POST   /v1/admin/expense-entities       — create entity
 * PATCH  /v1/admin/expense-entities/:id   — update entity
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 * No DELETE: entities referenced by financial data cannot be physically deleted.
 * Soft-delete via active=false is supported through PATCH.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PUBLIC_ENTITY_COLUMNS } from '../../services/dev-expenses-v4';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  code: z.string().min(1).max(100).trim(),
  display_name: z.string().min(1).max(200).trim(),
  entity_type: z.enum(['person', 'company', 'partner_group', 'project', 'other']),
  legal_name: z.string().max(200).optional(),
  trade_name: z.string().max(200).optional(),
  country_code: z.string().max(10).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  tax_id: z.string().max(100).optional(),
  // New legal profile fields
  registration_number: z.string().max(100).optional(),
  vat_number: z.string().max(100).optional(),
  address_line_1: z.string().max(500).optional(),
  address_line_2: z.string().max(500).optional(),
  region: z.string().max(100).optional(),
  contact_name: z.string().max(200).optional(),
  billing_email: z.string().max(200).optional(),
  contact_email: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
  legal_notes: z.string().max(2000).optional(),
  // Role capabilities
  can_incur_expenses: z.boolean().default(true),
  can_receive_invoices: z.boolean().default(true),
  can_pay_expenses: z.boolean().default(true),
  can_cover_expenses: z.boolean().default(true),
  can_receive_reimbursements: z.boolean().default(true),
  // Sensitive
  bank_details: z.record(z.unknown()).default({}),
  active: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
}).strict();

const patchSchema = z.object({
  display_name: z.string().min(1).max(200).trim().optional(),
  entity_type: z.enum(['person', 'company', 'partner_group', 'project', 'other']).optional(),
  legal_name: z.string().max(200).nullable().optional(),
  trade_name: z.string().max(200).nullable().optional(),
  country_code: z.string().max(10).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  tax_id: z.string().max(100).nullable().optional(),
  // New legal profile fields
  registration_number: z.string().max(100).nullable().optional(),
  vat_number: z.string().max(100).nullable().optional(),
  address_line_1: z.string().max(500).nullable().optional(),
  address_line_2: z.string().max(500).nullable().optional(),
  region: z.string().max(100).nullable().optional(),
  contact_name: z.string().max(200).nullable().optional(),
  billing_email: z.string().max(200).nullable().optional(),
  contact_email: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  legal_notes: z.string().max(2000).nullable().optional(),
  // Role capabilities
  can_incur_expenses: z.boolean().optional(),
  can_receive_invoices: z.boolean().optional(),
  can_pay_expenses: z.boolean().optional(),
  can_cover_expenses: z.boolean().optional(),
  can_receive_reimbursements: z.boolean().optional(),
  // Sensitive
  bank_details: z.record(z.unknown()).nullable().optional(),
  active: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

const adminExpenseEntitiesRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /admin/expense-entities ───────────────────────── */
  fastify.get<{ Querystring: {
    active?: string;
    entity_type?: string;
    can_incur_expenses?: string;
    can_receive_invoices?: string;
    can_pay_expenses?: string;
    can_cover_expenses?: string;
    can_receive_reimbursements?: string;
    country_code?: string;
    search?: string;
  } }>(
    '/admin/expense-entities',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      // Exclude bank_details from list responses
      let q = fastify.supabase.from('expense_entities').select(PUBLIC_ENTITY_COLUMNS);

      if (request.query.active !== undefined) {
        q = q.eq('active', request.query.active !== 'false');
      }
      if (request.query.entity_type) {
        q = q.eq('entity_type', request.query.entity_type);
      }
      if (request.query.can_incur_expenses !== undefined) {
        q = q.eq('can_incur_expenses', request.query.can_incur_expenses === 'true');
      }
      if (request.query.can_receive_invoices !== undefined) {
        q = q.eq('can_receive_invoices', request.query.can_receive_invoices === 'true');
      }
      if (request.query.can_pay_expenses !== undefined) {
        q = q.eq('can_pay_expenses', request.query.can_pay_expenses === 'true');
      }
      if (request.query.can_cover_expenses !== undefined) {
        q = q.eq('can_cover_expenses', request.query.can_cover_expenses === 'true');
      }
      if (request.query.can_receive_reimbursements !== undefined) {
        q = q.eq('can_receive_reimbursements', request.query.can_receive_reimbursements === 'true');
      }
      if (request.query.country_code) {
        q = q.eq('country_code', request.query.country_code);
      }
      if (request.query.search) {
        const s = request.query.search.trim();
        q = q.or(`display_name.ilike.%${s}%,legal_name.ilike.%${s}%,trade_name.ilike.%${s}%,registration_number.ilike.%${s}%,tax_id.ilike.%${s}%,vat_number.ilike.%${s}%,billing_email.ilike.%${s}%,city.ilike.%${s}%`);
      }

      const { data, error } = await q.order('display_name');

      if (error) {
        fastify.log.error({ err: error }, '[expense-entities] list failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { items: data ?? [] };
    },
  );

  /* ── POST /admin/expense-entities ──────────────────────── */
  fastify.post('/admin/expense-entities', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = createSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    const { data, error } = await fastify.supabase
      .from('expense_entities')
      .insert(parse.data)
      .select(PUBLIC_ENTITY_COLUMNS)
      .single();

    if (error) {
      if (error.code === '23505') {
        return reply.status(409).send({ error: 'Entity with this code already exists' });
      }
      fastify.log.error({ err: error }, '[expense-entities] insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.status(201).send({ entity: data });
  });

  /* ── PATCH /admin/expense-entities/:id ─────────────────── */
  fastify.patch<{ Params: { id: string } }>('/admin/expense-entities/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    if (!UUID_RE.test(request.params.id)) {
      return reply.status(400).send({ error: 'Invalid entity id (expected UUID)' });
    }

    const parse = patchSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    if (Object.keys(parse.data).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const { data, error } = await fastify.supabase
      .from('expense_entities')
      .update(parse.data)
      .eq('id', request.params.id)
      .select(PUBLIC_ENTITY_COLUMNS)
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[expense-entities] patch failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    if (!data) return reply.status(404).send({ error: 'Entity not found' });

    return { entity: data };
  });
};

export default adminExpenseEntitiesRoute;
