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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  code: z.string().min(1).max(100).trim(),
  display_name: z.string().min(1).max(200).trim(),
  entity_type: z.enum(['person', 'company', 'partner_group', 'project', 'other']),
  legal_name: z.string().max(200).optional(),
  country_code: z.string().max(10).optional(),
  active: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
}).strict();

const patchSchema = z.object({
  display_name: z.string().min(1).max(200).trim().optional(),
  entity_type: z.enum(['person', 'company', 'partner_group', 'project', 'other']).optional(),
  legal_name: z.string().max(200).nullable().optional(),
  country_code: z.string().max(10).nullable().optional(),
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
  fastify.get<{ Querystring: { active?: string; entity_type?: string } }>(
    '/admin/expense-entities',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      let q = fastify.supabase.from('expense_entities').select('*');

      if (request.query.active !== undefined) {
        q = q.eq('active', request.query.active !== 'false');
      }
      if (request.query.entity_type) {
        q = q.eq('entity_type', request.query.entity_type);
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
      .select()
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
      .select()
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
