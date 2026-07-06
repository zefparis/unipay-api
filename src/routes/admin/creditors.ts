/**
 * Admin routes — Creditors registry
 *
 * POST   /v1/admin/creditors       — create creditor
 * GET    /v1/admin/creditors       — list (filterable: active, entity_type)
 * PATCH  /v1/admin/creditors/:id   — update (name, email, payment details, etc.)
 * DELETE /v1/admin/creditors/:id   — soft-delete (active=false; never real delete)
 *
 * Auth: x-admin-secret (request.isAdmin set by HMAC plugin)
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.isAdmin) {
    reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    return false;
  }
  return true;
}

const createSchema = z.object({
  name:             z.string().min(1).max(200).trim(),
  entity_type:      z.enum(['cloud_provider', 'freelance', 'company', 'individual', 'other']),
  contact_email:    z.string().email().optional(),
  payment_method:   z.enum(['bank_transfer', 'mobile_money', 'crypto', 'other']).optional(),
  payment_details:  z.record(z.unknown()).optional(),
  default_category: z.string().max(100).trim().optional(),
  notes:            z.string().max(500).optional(),
});

const patchSchema = createSchema.partial();

const adminCreditorsRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /admin/creditors ──────────────────────────────── */
  fastify.post('/admin/creditors', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const parse = createSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
    }

    const { data: creditor, error } = await fastify.supabase
      .from('creditors')
      .insert({ ...parse.data, active: true })
      .select()
      .single();

    if (error) {
      fastify.log.error({ err: error }, '[creditors] insert failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.status(201).send({ creditor });
  });

  /* ── GET /admin/creditors ───────────────────────────────── */
  fastify.get<{ Querystring: { active?: string; entity_type?: string } }>(
    '/admin/creditors',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      let q = fastify.supabase.from('creditors').select('*');

      if (request.query.active !== undefined) {
        q = q.eq('active', request.query.active !== 'false');
      }
      if (request.query.entity_type) {
        q = q.eq('entity_type', request.query.entity_type);
      }

      const { data, error } = await q.order('name');

      if (error) {
        fastify.log.error({ err: error }, '[creditors] list query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return { data: data ?? [] };
    },
  );

  /* ── PATCH /admin/creditors/:id ─────────────────────────── */
  fastify.patch<{ Params: { id: string } }>(
    '/admin/creditors/:id',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid creditor id (expected UUID)' });
      }

      const parse = patchSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Validation error', details: parse.error.flatten().fieldErrors });
      }

      if (Object.keys(parse.data).length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }

      const { data, error } = await fastify.supabase
        .from('creditors')
        .update(parse.data)
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[creditors] patch failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      if (!data) return reply.status(404).send({ error: 'Creditor not found' });

      return { creditor: data };
    },
  );

  /* ── DELETE /admin/creditors/:id (soft-delete) ──────────── */
  fastify.delete<{ Params: { id: string } }>(
    '/admin/creditors/:id',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      if (!UUID_RE.test(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid creditor id (expected UUID)' });
      }

      // Count linked expenses (informational — never blocks delete)
      const { count } = await fastify.supabase
        .from('dev_expenses')
        .select('*', { count: 'exact', head: true })
        .eq('creditor_id', request.params.id);

      const { data, error } = await fastify.supabase
        .from('creditors')
        .update({ active: false })
        .eq('id', request.params.id)
        .select()
        .single();

      if (error) {
        fastify.log.error({ err: error }, '[creditors] soft-delete failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      if (!data) return reply.status(404).send({ error: 'Creditor not found' });

      return { creditor: data, linked_expenses: count ?? 0 };
    },
  );
};

export default adminCreditorsRoute;
