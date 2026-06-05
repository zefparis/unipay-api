import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { verifyToken } from '../../utils/jwt.js';

interface KycBody {
  company_name: string;
  company_rccm?: string;
  company_idnat?: string;
}

function requireMerchant(auth: string | undefined, secret: string): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  const payload = verifyToken(auth.slice(7), secret);
  return payload?.merchant_id ?? null;
}

const merchantKycRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/merchant/kyc ───────────────────────────────── */
  fastify.get(
    '/merchant/kyc',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              kyc_status:        { type: 'string' },
              kyc_submitted_at:  { type: ['string', 'null'] },
              kyc_reviewed_at:   { type: ['string', 'null'] },
              kyc_notes:         { type: ['string', 'null'] },
              company_name:      { type: ['string', 'null'] },
              company_rccm:      { type: ['string', 'null'] },
              company_idnat:     { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { data } = await fastify.supabase
        .from('merchants')
        .select('kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_notes, company_name, company_rccm, company_idnat')
        .eq('id', merchantId)
        .maybeSingle();

      return reply.send({
        kyc_status:       data?.kyc_status       ?? 'pending',
        kyc_submitted_at: data?.kyc_submitted_at ?? null,
        kyc_reviewed_at:  data?.kyc_reviewed_at  ?? null,
        kyc_notes:        data?.kyc_notes        ?? null,
        company_name:     data?.company_name     ?? null,
        company_rccm:     data?.company_rccm     ?? null,
        company_idnat:    data?.company_idnat    ?? null,
      });
    },
  );

  /* ── POST /v1/merchant/kyc ──────────────────────────────── */
  fastify.post<{ Body: KycBody }>(
    '/merchant/kyc',
    {
      schema: {
        body: {
          type: 'object',
          required: ['company_name'],
          properties: {
            company_name:  { type: 'string', minLength: 2, maxLength: 256 },
            company_rccm:  { type: 'string', maxLength: 128 },
            company_idnat: { type: 'string', maxLength: 128 },
          },
        },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' }, kyc_status: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
      const merchantId = requireMerchant(request.headers.authorization, env.JWT_SECRET);
      if (!merchantId) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { company_name, company_rccm, company_idnat } = request.body;

      const { error } = await fastify.supabase
        .from('merchants')
        .update({
          company_name,
          company_rccm:    company_rccm    ?? null,
          company_idnat:   company_idnat   ?? null,
          kyc_status:      'pending',
          kyc_submitted_at: new Date().toISOString(),
          kyc_notes:       null,
        })
        .eq('id', merchantId);

      if (error) {
        fastify.log.error({ err: error, merchantId }, 'KYC submit failed');
        return reply.status(500).send({ error: 'KYC submission failed', statusCode: 500 });
      }

      fastify.log.info({ merchantId, company_name }, 'KYC submitted');
      return reply.send({ ok: true, kyc_status: 'pending' });
    },
  );
};

export default merchantKycRoute;
