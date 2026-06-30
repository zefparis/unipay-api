import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

const walletInspectRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { reference: string } }>(
    '/admin/wallet/inspect/:reference',
    async (request, reply) => {
      const adminSecret = process.env['ADMIN_SECRET'];
      const _provided = Buffer.from(String(request.headers['x-admin-secret'] ?? ''));
      const _expected = Buffer.from(adminSecret ?? '');
      if (!adminSecret || _provided.length !== _expected.length || !crypto.timingSafeEqual(_provided, _expected)) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { reference } = request.params;

      const { data: tx, error: txErr } = await fastify.supabase
        .from('transactions')
        .select('id, reference, status, direction, amount, fee, net_amount, wallet_user_id, operator, phone, avada_transaction_id, created_at, metadata')
        .eq('reference', reference)
        .maybeSingle();

      if (txErr) return reply.status(500).send({ error: txErr.message });
      if (!tx)   return reply.status(404).send({ error: `Not found: ${reference}` });

      let wallet = null;
      if (tx.wallet_user_id) {
        const { data } = await fastify.supabase
          .from('wallet_users')
          .select('id, phone, full_name, balance_cdf, is_active, kyc_level')
          .eq('id', tx.wallet_user_id)
          .maybeSingle();
        wallet = data;
      }

      return reply.send({ transaction: tx, wallet });
    },
  );
};

export default walletInspectRoute;
