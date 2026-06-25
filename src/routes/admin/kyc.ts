import type { FastifyPluginAsync } from 'fastify';
import { sendKycApprovedEmail, sendKycRejectedEmail } from '../../services/email.js';

interface KycListQuery {
  kyc_status?: 'pending' | 'approved' | 'rejected';
  page: number;
  limit: number;
}

interface RejectBody {
  notes: string;
}

const adminKycRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/admin/kyc ──────────────────────────────────── */
  fastify.get<{ Querystring: KycListQuery }>(
    '/admin/kyc',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            kyc_status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });

      const { kyc_status, page, limit } = request.query;
      const offset = (page - 1) * limit;

      let query = fastify.supabase
        .from('merchants')
        .select('id, name, email, company_name, company_rccm, company_idnat, kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_notes, created_at', { count: 'exact' })
        .order('kyc_submitted_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (kyc_status) query = query.eq('kyc_status', kyc_status);

      const { data, error, count } = await query;

      if (error) {
        fastify.log.error({ err: error }, 'Admin KYC list query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      return reply.send({
        data: data ?? [],
        pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
      });
    },
  );

  /* ── POST /v1/admin/kyc/:merchant_id/approve ─────────────── */
  fastify.post<{ Params: { merchant_id: string } }>(
    '/admin/kyc/:merchant_id/approve',
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });

      const { merchant_id } = request.params;

      const { data: merchant, error: fetchError } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, kyc_status')
        .eq('id', merchant_id)
        .maybeSingle();

      if (fetchError || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      const { error } = await fastify.supabase
        .from('merchants')
        .update({ kyc_status: 'approved', mode: 'live', kyc_reviewed_at: new Date().toISOString(), kyc_notes: null })
        .eq('id', merchant_id);

      if (error) {
        fastify.log.error({ err: error, merchant_id }, 'KYC approval failed');
        return reply.status(500).send({ error: 'Approval failed', statusCode: 500 });
      }

      fastify.log.info({ merchant_id, email: merchant.email }, 'KYC approved');

      sendKycApprovedEmail(merchant.email as string, merchant.name as string).catch((err: unknown) => {
        fastify.log.error({ err, merchant_id }, 'KYC approval email failed');
      });

      return reply.send({ ok: true, kyc_status: 'approved' });
    },
  );

  /* ── POST /v1/admin/kyc/:merchant_id/reject ──────────────── */
  fastify.post<{ Params: { merchant_id: string }; Body: RejectBody }>(
    '/admin/kyc/:merchant_id/reject',
    {
      schema: {
        body: {
          type: 'object',
          required: ['notes'],
          properties: {
            notes: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });

      const { merchant_id } = request.params;
      const { notes } = request.body;

      const { data: merchant, error: fetchError } = await fastify.supabase
        .from('merchants')
        .select('id, name, email')
        .eq('id', merchant_id)
        .maybeSingle();

      if (fetchError || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      const { error } = await fastify.supabase
        .from('merchants')
        .update({ kyc_status: 'rejected', kyc_reviewed_at: new Date().toISOString(), kyc_notes: notes })
        .eq('id', merchant_id);

      if (error) {
        fastify.log.error({ err: error, merchant_id }, 'KYC rejection failed');
        return reply.status(500).send({ error: 'Rejection failed', statusCode: 500 });
      }

      fastify.log.info({ merchant_id, email: merchant.email }, 'KYC rejected');

      sendKycRejectedEmail(merchant.email as string, merchant.name as string, notes).catch((err: unknown) => {
        fastify.log.error({ err, merchant_id }, 'KYC rejection email failed');
      });

      return reply.send({ ok: true, kyc_status: 'rejected' });
    },
  );
};

export default adminKycRoute;
