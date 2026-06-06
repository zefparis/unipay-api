import type { FastifyPluginAsync } from 'fastify';

const walletReconcileRoute: FastifyPluginAsync = async (fastify) => {
  // POST /admin/wallet/reconcile
  // Credits wallet balance for a WD- transaction stuck in 'processing'.
  // Protected by ADMIN_SECRET header.
  fastify.post<{ Body: { reference: string } }>(
    '/admin/wallet/reconcile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reference'],
          properties: {
            reference: { type: 'string', pattern: '^WD-' },
          },
        },
      },
    },
    async (request, reply) => {
      const adminSecret = process.env['ADMIN_SECRET'];
      if (!adminSecret || request.headers['x-admin-secret'] !== adminSecret) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { reference } = request.body;

      const { data: tx, error: txErr } = await fastify.supabase
        .from('transactions')
        .select('id, status, wallet_user_id, direction, net_amount')
        .eq('reference', reference)
        .maybeSingle();

      if (txErr) {
        return reply.status(500).send({ error: txErr.message });
      }
      if (!tx) {
        return reply.status(404).send({ error: `Transaction ${reference} not found` });
      }
      if (tx.status === 'success') {
        return reply.send({ ok: true, message: 'Already credited', reference });
      }
      if (tx.direction !== 'collect') {
        return reply.status(400).send({ error: 'Only collect transactions can be reconciled here' });
      }
      if (!tx.wallet_user_id) {
        return reply.status(400).send({ error: 'No wallet_user_id on transaction' });
      }

      const netAmount = Number(tx.net_amount ?? 0);

      // 1. Mark transaction as success
      const { error: updateErr } = await fastify.supabase
        .from('transactions')
        .update({ status: 'success' })
        .eq('id', tx.id)
        .neq('status', 'success');

      if (updateErr) {
        return reply.status(500).send({ error: updateErr.message });
      }

      // 2. Credit wallet balance
      const { data: walletRow } = await fastify.supabase
        .from('wallet_users')
        .select('balance_cdf')
        .eq('id', tx.wallet_user_id)
        .maybeSingle();

      if (!walletRow) {
        return reply.status(404).send({ error: 'Wallet user not found' });
      }

      const newBalance = Number(walletRow.balance_cdf ?? 0) + netAmount;
      const { error: creditErr } = await fastify.supabase
        .from('wallet_users')
        .update({ balance_cdf: newBalance })
        .eq('id', tx.wallet_user_id);

      if (creditErr) {
        return reply.status(500).send({ error: creditErr.message });
      }

      fastify.log.info({ reference, walletUserId: tx.wallet_user_id, netAmount, newBalance }, '[reconcile] wallet credited');

      return reply.send({
        ok: true,
        reference,
        credited: netAmount,
        new_balance: newBalance,
      });
    },
  );
};

export default walletReconcileRoute;
