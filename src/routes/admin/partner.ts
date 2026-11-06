import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { logAdminAction } from '../../lib/admin-action-log.js';
import { PROVIDER_FEE_RATE } from '../../lib/partner-commission.js';
import { errorResponses } from '../../lib/error-schema.js';

/**
 * Partner (referral) program — admin endpoints.
 * Auth: request.isAdmin via x-admin-secret / CRON_SERVICE_SECRET (hmac plugin).
 *
 *   POST /v1/admin/merchants/:id/partner          — enable/disable partner + rate
 *   PATCH /v1/admin/merchants/:id/referrer        — set/clear sub-merchant referrer
 *   GET  /v1/admin/partner-commissions            — global commission view (filters)
 *   POST /v1/admin/partner-commissions/:id/reverse — counter-entry (contrepassation)
 *   POST /v1/admin/partner-commissions/backfill   — recompute missing commissions
 */

interface PartnerToggleBody {
  enabled: boolean;
  rate?: number;
}

interface ReferrerBody {
  partner_id: string | null;
}

interface CommissionsQuery {
  page?: number;
  limit?: number;
  partner_merchant_id?: string;
  sub_merchant_id?: string;
  status?: 'credited' | 'reversed';
  currency?: 'CDF' | 'USD' | 'USDT';
  date_from?: string;
  date_to?: string;
}

interface BackfillBody {
  date_from: string;
  date_to: string;
}

function generatePartnerCode(): string {
  return `PRT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const adminPartnerRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/admin/merchants/:id/partner ─────────────────── */
  fastify.post<{ Params: { id: string }; Body: PartnerToggleBody }>(
    '/admin/merchants/:id/partner',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
            rate:    { type: 'number', minimum: 0, maximum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const { enabled, rate } = request.body;

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, is_partner, partner_code, partner_rate, deleted_at')
        .eq('id', id)
        .maybeSingle();

      if (error) return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      if (!merchant || merchant.deleted_at !== null) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      const update: Record<string, unknown> = {
        is_partner: enabled,
        updated_at: new Date().toISOString(),
      };
      if (rate !== undefined) update.partner_rate = rate;

      if (enabled && !merchant.partner_code) {
        // Generate a unique partner_code — retry a few times on the
        // (astronomically unlikely) UNIQUE collision.
        let assigned = false;
        for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
          const candidate = generatePartnerCode();
          const { error: updErr } = await fastify.supabase
            .from('merchants')
            .update({ ...update, partner_code: candidate })
            .eq('id', id);
          if (!updErr) {
            update.partner_code = candidate;
            assigned = true;
          } else if (!String(updErr.message).includes('partner_code')) {
            fastify.log.error({ err: updErr, merchantId: id }, '[admin/partner] enable failed');
            return reply.status(500).send({ error: 'Failed to enable partner', statusCode: 500 });
          }
        }
        if (!assigned) {
          return reply.status(500).send({ error: 'Failed to generate partner code', statusCode: 500 });
        }
      } else {
        const { error: updErr } = await fastify.supabase
          .from('merchants')
          .update(update)
          .eq('id', id);
        if (updErr) {
          fastify.log.error({ err: updErr, merchantId: id }, '[admin/partner] update failed');
          return reply.status(500).send({ error: 'Failed to update partner', statusCode: 500 });
        }
      }

      void logAdminAction(
        fastify.supabase,
        enabled ? 'merchant.partner_enable' : 'merchant.partner_disable',
        'merchant',
        id,
        { enabled, rate: rate ?? merchant.partner_rate, partner_code: update.partner_code ?? merchant.partner_code },
        fastify.log,
      );

      return reply.send({
        merchant_id: id,
        is_partner: enabled,
        partner_code: (update.partner_code as string | undefined) ?? (merchant.partner_code as string | null) ?? null,
        partner_rate: rate ?? Number(merchant.partner_rate ?? 0.01),
      });
    },
  );

  /* ── PATCH /v1/admin/merchants/:id/referrer ───────────────── */
  fastify.patch<{ Params: { id: string }; Body: ReferrerBody }>(
    '/admin/merchants/:id/referrer',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['partner_id'],
          properties: {
            partner_id: { type: ['string', 'null'], format: 'uuid' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const { partner_id: partnerId } = request.body;

      if (partnerId === id) {
        return reply.status(400).send({ error: 'SELF_REFERRAL_FORBIDDEN', statusCode: 400 });
      }

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, referred_by_partner_id, deleted_at')
        .eq('id', id)
        .maybeSingle();

      if (error) return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      if (!merchant || merchant.deleted_at !== null) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      if (partnerId !== null) {
        const { data: partner } = await fastify.supabase
          .from('merchants')
          .select('id, is_partner, status, deleted_at')
          .eq('id', partnerId)
          .maybeSingle();

        if (!partner || partner.deleted_at !== null) {
          return reply.status(404).send({ error: 'Partner not found', statusCode: 404 });
        }
        if (partner.is_partner !== true || partner.status !== 'active') {
          return reply.status(400).send({ error: 'PARTNER_NOT_ACTIVE', statusCode: 400 });
        }
      }

      const previous = (merchant.referred_by_partner_id as string | null) ?? null;
      const { error: updErr } = await fastify.supabase
        .from('merchants')
        .update({ referred_by_partner_id: partnerId, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (updErr) {
        fastify.log.error({ err: updErr, merchantId: id, partnerId }, '[admin/referrer] update failed');
        return reply.status(500).send({ error: 'Failed to update referrer', statusCode: 500 });
      }

      void logAdminAction(
        fastify.supabase,
        'merchant.referrer_update',
        'merchant',
        id,
        { previous_referrer: previous, new_referrer: partnerId },
        fastify.log,
      );

      return reply.send({
        merchant_id: id,
        previous_referrer: previous,
        referred_by_partner_id: partnerId,
      });
    },
  );

  /* ── GET /v1/admin/partner-commissions ────────────────────── */
  fastify.get<{ Querystring: CommissionsQuery }>(
    '/admin/partner-commissions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:                { type: 'integer', minimum: 1, default: 1 },
            limit:               { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            partner_merchant_id: { type: 'string', format: 'uuid' },
            sub_merchant_id:     { type: 'string', format: 'uuid' },
            status:              { type: 'string', enum: ['credited', 'reversed'] },
            currency:            { type: 'string', enum: ['CDF', 'USD', 'USDT'] },
            date_from:           { type: 'string', format: 'date-time' },
            date_to:             { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 50;
      const offset = (page - 1) * limit;

      let query = fastify.supabase
        .from('partner_commissions')
        .select('id, partner_merchant_id, sub_merchant_id, transaction_id, currency, transaction_amount, rate, commission_amount, status, created_at, reversed_at, reverse_reason', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      const q = request.query;
      if (q.partner_merchant_id) query = query.eq('partner_merchant_id', q.partner_merchant_id);
      if (q.sub_merchant_id) query = query.eq('sub_merchant_id', q.sub_merchant_id);
      if (q.status) query = query.eq('status', q.status);
      if (q.currency) query = query.eq('currency', q.currency);
      if (q.date_from) query = query.gte('created_at', q.date_from);
      if (q.date_to) query = query.lte('created_at', q.date_to);

      const { data: rows, error, count } = await query;
      if (error) {
        fastify.log.error({ err: error }, '[admin/partner-commissions] query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      // Resolve merchant display names for both sides of each row
      const merchantIds = new Set<string>();
      for (const r of rows ?? []) {
        merchantIds.add((r as { partner_merchant_id: string }).partner_merchant_id);
        merchantIds.add((r as { sub_merchant_id: string }).sub_merchant_id);
      }
      const nameMap: Record<string, string> = {};
      if (merchantIds.size > 0) {
        const { data: merchants } = await fastify.supabase
          .from('merchants')
          .select('id, name')
          .in('id', [...merchantIds]);
        for (const m of merchants ?? []) {
          nameMap[(m as { id: string }).id] = (m as { name: string }).name;
        }
      }

      const data = (rows ?? []).map((r) => {
        const row = r as Record<string, unknown> & { partner_merchant_id: string; sub_merchant_id: string };
        return {
          ...row,
          partner_merchant_name: nameMap[row.partner_merchant_id] ?? null,
          sub_merchant_name: nameMap[row.sub_merchant_id] ?? null,
        };
      });

      return reply.send({
        data,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / limit),
        },
      });
    },
  );

  /* ── POST /v1/admin/partner-commissions/:id/reverse ───────── */
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/partner-commissions/:id/reverse',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string', maxLength: 500 } },
          additionalProperties: false,
        },
        response: {
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const reason = request.body?.reason ?? null;

      const { data: commission, error } = await fastify.supabase
        .from('partner_commissions')
        .select('id, transaction_id, status, partner_merchant_id, commission_amount, currency')
        .eq('id', id)
        .maybeSingle();

      if (error) return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      if (!commission) {
        return reply.status(404).send({ error: 'Commission not found', statusCode: 404 });
      }

      const { data: result, error: rpcErr } = await fastify.supabase.rpc(
        'reverse_partner_commission',
        {
          p_transaction_id: commission.transaction_id,
          p_reason: reason,
        },
      );

      if (rpcErr) {
        fastify.log.error({ err: rpcErr, commissionId: id }, '[admin/reverse] RPC failed');
        return reply.status(500).send({ error: 'Reversal failed', statusCode: 500 });
      }

      const res = result as { status?: string } | null;
      if (res?.status === 'already_reversed') {
        return reply.status(409).send({ error: 'Commission already reversed', statusCode: 409 });
      }
      if (res?.status !== 'reversed') {
        return reply.status(500).send({ error: 'Reversal failed', statusCode: 500 });
      }

      fastify.log.info({
        event: 'partner_commission_reversed',
        commissionId: id,
        transactionId: commission.transaction_id,
        partnerMerchantId: commission.partner_merchant_id,
        amount: commission.commission_amount,
        currency: commission.currency,
        reason,
      }, 'partner commission reversed');

      void logAdminAction(
        fastify.supabase,
        'partner_commission.reverse',
        'partner_commission',
        id,
        { transaction_id: commission.transaction_id, reason },
        fastify.log,
      );

      return reply.send({ ...res });
    },
  );

  /* ── POST /v1/admin/partner-commissions/backfill ──────────── */
  fastify.post<{ Body: BackfillBody }>(
    '/admin/partner-commissions/backfill',
    {
      schema: {
        body: {
          type: 'object',
          required: ['date_from', 'date_to'],
          properties: {
            date_from: { type: 'string', format: 'date-time' },
            date_to:   { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { date_from, date_to } = request.body;
      if (new Date(date_from) >= new Date(date_to)) {
        return reply.status(400).send({ error: 'date_from must be before date_to', statusCode: 400 });
      }

      const { data: result, error: rpcErr } = await fastify.supabase.rpc(
        'backfill_partner_commissions',
        {
          p_date_from: date_from,
          p_date_to: date_to,
          p_provider_fee_rate: PROVIDER_FEE_RATE,
        },
      );

      if (rpcErr) {
        fastify.log.error({ err: rpcErr, date_from, date_to }, '[admin/backfill] RPC failed');
        return reply.status(500).send({ error: 'Backfill failed', statusCode: 500 });
      }

      fastify.log.info({
        event: 'partner_commission_backfill',
        date_from,
        date_to,
        result,
      }, 'partner commission backfill completed');

      void logAdminAction(
        fastify.supabase,
        'partner_commission.backfill',
        'partner_commission',
        null,
        { date_from, date_to, result },
        fastify.log,
      );

      return reply.send(result ?? {});
    },
  );
};

export default adminPartnerRoute;
