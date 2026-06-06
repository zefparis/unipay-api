import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

interface PatchProfileBody { full_name: string }

const walletProfileRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/wallet/profile ─────────────────────────────── */
  fastify.get(
    '/wallet/profile',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              wallet_id:   { type: 'string' },
              phone:       { type: 'string' },
              full_name:   { type: ['string', 'null'] },
              kyc_level:   { type: 'number' },
              is_verified: { type: 'boolean' },
              balance_cdf: { type: 'number' },
              created_at:  { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const { data, error } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, full_name, kyc_level, is_verified, balance_cdf, created_at')
        .eq('id', wp.wallet_id)
        .maybeSingle();

      if (error || !data) return reply.status(404).send({ error: 'Wallet not found' });

      return reply.send({
        wallet_id:   data.id,
        phone:       data.phone,
        full_name:   data.full_name ?? null,
        kyc_level:   Number(data.kyc_level ?? 0),
        is_verified: Boolean(data.is_verified),
        balance_cdf: Number(data.balance_cdf ?? 0),
        created_at:  data.created_at,
      });
    },
  );

  /* ── PATCH /v1/wallet/profile ───────────────────────────── */
  fastify.patch<{ Body: PatchProfileBody }>(
    '/wallet/profile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['full_name'],
          properties: {
            full_name: { type: 'string', minLength: 2, maxLength: 100 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok:        { type: 'boolean' },
              full_name: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });
      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized' });

      const { full_name } = request.body;
      const { error } = await fastify.supabase
        .from('wallet_users')
        .update({ full_name })
        .eq('id', wp.wallet_id);

      if (error) {
        fastify.log.error({ err: error, walletId: wp.wallet_id }, 'Profile update failed');
        return reply.status(500).send({ error: 'Update failed' });
      }

      fastify.log.info({ walletId: wp.wallet_id }, 'Profile updated');
      return reply.send({ ok: true, full_name });
    },
  );
};

export default walletProfileRoute;
