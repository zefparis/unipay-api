import type { FastifyPluginAsync } from 'fastify';
import { initiatePayout } from '../../services/avada.js';
import { normalizePhoneForOperator, isValidDrcPhone } from '../../lib/phone-normalization.js';
import { markSettlementSuccess, markSettlementFailed, rejectSettlement } from '../merchant/settlement-rpc-helpers.js';
import { logAdminAction } from '../../lib/admin-action-log.js';

function requireAdmin(isAdmin: boolean): boolean {
  return isAdmin;
}

interface ApproveBody {
  operator?: string;
}

interface RejectBody {
  reason: string;
}

const adminSettlementRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/admin/settlements/pending-review ──────────────── */
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/admin/settlements/pending-review',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 50;
      const offset = (page - 1) * limit;

      const { data: requests, error, count } = await fastify.supabase
        .from('merchant_settlement_requests')
        .select(
          'id, merchant_id, amount, phone, status, created_at, updated_at, merchants(name, email)',
          { count: 'exact' },
        )
        .eq('status', 'pending_admin_review')
        .order('created_at', { ascending: true })
        .range(offset, offset + limit - 1);

      if (error) {
        fastify.log.error({ err: error }, '[admin/settlements] pending-review query failed');
        return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
      }

      return reply.send({
        requests: requests ?? [],
        total: count ?? 0,
        page,
        limit,
      });
    },
  );

  /* ── POST /v1/admin/settlements/:id/approve ────────────────── */
  fastify.post<{ Params: { id: string }; Body: ApproveBody }>(
    '/admin/settlements/:id/approve',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            operator: { type: 'string', enum: ['orange', 'airtel', 'afrimoney'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;

      // Fetch the settlement request
      const { data: settlement, error: fetchErr } = await fastify.supabase
        .from('merchant_settlement_requests')
        .select('id, merchant_id, amount, phone, status')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr || !settlement) {
        return reply.status(404).send({ error: 'Settlement request not found', statusCode: 404 });
      }

      if (settlement.status !== 'pending_admin_review') {
        return reply.status(409).send({
          error: 'SETTLEMENT_NOT_REVIEWABLE',
          message: `Settlement status is '${settlement.status}', expected 'pending_admin_review'.`,
          statusCode: 409,
        });
      }

      // Validate phone
      if (!isValidDrcPhone(settlement.phone)) {
        return reply.status(400).send({
          error: 'INVALID_SETTLEMENT_PHONE',
          message: 'Le numéro de règlement est invalide.',
          statusCode: 400,
        });
      }

      const operator = (request.body?.operator ?? 'orange') as 'orange' | 'airtel' | 'afrimoney';
      const normalizedPhone = normalizePhoneForOperator(settlement.phone, operator);

      // Mark as processing
      await fastify.supabase
        .from('merchant_settlement_requests')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', id);

      try {
        fastify.log.info(
          { requestId: id, merchantId: settlement.merchant_id, amount: settlement.amount, phone: normalizedPhone, operator },
          '[admin/settlements] approve — triggering B2C payout',
        );

        const payoutRes = await initiatePayout(
          operator,
          normalizedPhone,
          Number(settlement.amount),
          `STL-${id.slice(0, 8).toUpperCase()}`,
          'CDF',
        );

        await markSettlementSuccess(fastify.supabase, id, payoutRes.avada_transaction_id);

        void logAdminAction(fastify.supabase, 'settlement.approve', 'settlement', id, { merchant_id: settlement.merchant_id, amount: settlement.amount, operator, phone: normalizedPhone }, fastify.log);

        return reply.send({
          approved: true,
          request_id: id,
          provider_ref: payoutRes.avada_transaction_id,
          status: 'success',
        });
      } catch (err: any) {
        fastify.log.error(
          { err: err?.message, requestId: id },
          '[admin/settlements] approve — payout failed',
        );
        await markSettlementFailed(fastify.supabase, id, `Payout failed: ${err?.message ?? 'unknown'}`);
        return reply.status(502).send({
          error: 'PAYOUT_FAILED',
          message: 'Le payout a échoué. Le solde a été recrédité au marchand.',
          request_id: id,
          statusCode: 502,
        });
      }
    },
  );

  /* ── POST /v1/admin/settlements/:id/reject ─────────────────── */
  fastify.post<{ Params: { id: string }; Body: RejectBody }>(
    '/admin/settlements/:id/reject',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const { reason } = request.body;

      try {
        const result = await rejectSettlement(fastify.supabase, id, reason);
        void logAdminAction(fastify.supabase, 'settlement.reject', 'settlement', id, { reason }, fastify.log);
        return reply.send({
          rejected: true,
          request_id: id,
          recredited: result.recredited,
          balance_after: result.balance_after,
        });
      } catch (err: any) {
        const msg = err?.message ?? '';
        if (msg.includes('SETTLEMENT_NOT_FOUND')) {
          return reply.status(404).send({ error: 'Settlement request not found', statusCode: 404 });
        }
        if (msg.includes('SETTLEMENT_ALREADY_TERMINAL')) {
          return reply.status(409).send({
            error: 'SETTLEMENT_ALREADY_TERMINAL',
            message: 'Ce règlement est déjà dans un état terminal.',
            statusCode: 409,
          });
        }
        fastify.log.error({ err, requestId: id }, '[admin/settlements] reject failed');
        return reply.status(500).send({ error: 'Rejection failed', statusCode: 500 });
      }
    },
  );
};

export default adminSettlementRoute;
