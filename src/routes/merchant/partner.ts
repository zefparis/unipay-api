import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { requireMerchantIdentity } from '../../lib/merchant-auth.js';
import { errorResponses } from '../../lib/error-schema.js';

/**
 * Partner (referral) program — merchant endpoints.
 * Dual auth: dashboard JWT session OR X-API-Key (requireMerchantIdentity).
 *
 *   GET /v1/merchant/partner              — partner status, code, referral link, rate
 *   GET /v1/merchant/partner/clients      — referred sub-merchants + success volume
 *   GET /v1/merchant/partner/commissions  — commission lines + totals per currency
 */

interface ClientsQuery {
  page?: number;
  limit?: number;
}

interface CommissionsQuery {
  page?: number;
  limit?: number;
  status?: 'credited' | 'reversed';
  currency?: 'CDF' | 'USD' | 'USDT';
  date_from?: string;
  date_to?: string;
}

const partnerRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/merchant/partner ─────────────────────────────── */
  fastify.get(
    '/merchant/partner',
    async (request, reply) => {
      const auth = await requireMerchantIdentity(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, is_partner, partner_code, partner_rate, referred_by_partner_id')
        .eq('id', auth.merchantId)
        .maybeSingle();

      if (error || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      let referredBy: { merchant_id: string; name: string } | null = null;
      if (merchant.referred_by_partner_id) {
        const { data: partner } = await fastify.supabase
          .from('merchants')
          .select('id, name')
          .eq('id', merchant.referred_by_partner_id)
          .maybeSingle();
        if (partner) {
          referredBy = { merchant_id: partner.id as string, name: partner.name as string };
        }
      }

      const partnerCode = (merchant.partner_code as string | null) ?? null;
      return reply.send({
        is_partner: merchant.is_partner === true,
        partner_code: partnerCode,
        referral_url: partnerCode
          ? `${env.MERCHANT_PORTAL_URL}/register?ref=${encodeURIComponent(partnerCode)}`
          : null,
        partner_rate: Number(merchant.partner_rate ?? 0),
        referred_by: referredBy,
      });
    },
  );

  /* ── GET /v1/merchant/partner/clients ─────────────────────── */
  fastify.get<{ Querystring: ClientsQuery }>(
    '/merchant/partner/clients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireMerchantIdentity(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const offset = (page - 1) * limit;

      const { data: clients, error, count } = await fastify.supabase
        .from('merchants')
        .select('id, name, created_at, kyc_status, status', { count: 'exact' })
        .eq('referred_by_partner_id', auth.merchantId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        fastify.log.error({ err: error, merchantId: auth.merchantId }, '[partner/clients] query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      // Success volume per currency for the listed sub-merchants.
      const clientIds = (clients ?? []).map((c) => (c as { id: string }).id);
      const volumeMap: Record<string, Record<string, number>> = {};
      if (clientIds.length > 0) {
        const { data: txs } = await fastify.supabase
          .from('transactions')
          .select('merchant_id, net_amount, currency')
          .in('merchant_id', clientIds)
          .eq('status', 'success');

        for (const tx of txs ?? []) {
          const mid = (tx as { merchant_id: string }).merchant_id;
          const cur = (tx as { currency?: string }).currency ?? 'CDF';
          if (!volumeMap[mid]) volumeMap[mid] = {};
          volumeMap[mid][cur] = (volumeMap[mid][cur] ?? 0) + Number((tx as { net_amount?: number }).net_amount ?? 0);
        }
      }

      const data = (clients ?? []).map((c) => {
        const row = c as { id: string; name: string; created_at: string; kyc_status: string; status: string };
        return {
          id: row.id,
          name: row.name,
          registered_at: row.created_at,
          kyc_status: row.kyc_status,
          status: row.status,
          success_volume: volumeMap[row.id] ?? {},
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

  /* ── GET /v1/merchant/partner/commissions ─────────────────── */
  fastify.get<{ Querystring: CommissionsQuery }>(
    '/merchant/partner/commissions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:      { type: 'integer', minimum: 1, default: 1 },
            limit:     { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status:    { type: 'string', enum: ['credited', 'reversed'] },
            currency:  { type: 'string', enum: ['CDF', 'USD', 'USDT'] },
            date_from: { type: 'string', format: 'date-time' },
            date_to:   { type: 'string', format: 'date-time' },
          },
        },
        response: {
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const auth = await requireMerchantIdentity(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const offset = (page - 1) * limit;

      const applyFilters = <T extends { eq: Function; gte: Function; lte: Function }>(q: T): T => {
        if (request.query.status) q = q.eq('status', request.query.status);
        if (request.query.currency) q = q.eq('currency', request.query.currency);
        if (request.query.date_from) q = q.gte('created_at', request.query.date_from);
        if (request.query.date_to) q = q.lte('created_at', request.query.date_to);
        return q;
      };

      const query = applyFilters(
        fastify.supabase
          .from('partner_commissions')
          .select('id, sub_merchant_id, transaction_id, currency, transaction_amount, rate, commission_amount, status, created_at, reversed_at, reverse_reason', { count: 'exact' })
          .eq('partner_merchant_id', auth.merchantId)
          .order('created_at', { ascending: false }),
      );

      const { data: rows, error, count } = await query.range(offset, offset + limit - 1);
      if (error) {
        fastify.log.error({ err: error, merchantId: auth.merchantId }, '[partner/commissions] query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      // Sub-merchant display names for this page
      const subIds = [...new Set((rows ?? []).map((r) => (r as { sub_merchant_id: string }).sub_merchant_id))];
      const nameMap: Record<string, string> = {};
      if (subIds.length > 0) {
        const { data: subs } = await fastify.supabase
          .from('merchants')
          .select('id, name')
          .in('id', subIds);
        for (const s of subs ?? []) {
          nameMap[(s as { id: string }).id] = (s as { name: string }).name;
        }
      }

      // Totals per currency over the WHOLE filtered set (not just the page):
      // credited counts positive, reversed subtracts.
      const totalsQuery = applyFilters(
        fastify.supabase
          .from('partner_commissions')
          .select('currency, commission_amount, status')
          .eq('partner_merchant_id', auth.merchantId),
      );
      const { data: totalsRows } = await totalsQuery;

      const totals: Record<string, number> = {};
      for (const r of totalsRows ?? []) {
        const cur = (r as { currency: string }).currency;
        const amt = Number((r as { commission_amount: number }).commission_amount ?? 0);
        const signed = (r as { status: string }).status === 'reversed' ? -amt : amt;
        totals[cur] = (totals[cur] ?? 0) + signed;
      }
      for (const cur of Object.keys(totals)) {
        totals[cur] = Math.round(totals[cur] * 10000) / 10000;
      }

      const data = (rows ?? []).map((r) => {
        const row = r as Record<string, unknown> & { sub_merchant_id: string };
        return { ...row, sub_merchant_name: nameMap[row.sub_merchant_id] ?? null };
      });

      return reply.send({
        data,
        totals,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / limit),
        },
      });
    },
  );
};

export default partnerRoute;
