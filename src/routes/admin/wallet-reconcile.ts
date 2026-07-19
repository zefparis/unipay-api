import type { FastifyPluginAsync } from 'fastify';
import { safeSecretEqual } from '../../security/secret-compare';

interface ReconcileBody {
  reference: string;
  force_status?: 'success' | 'failed';
}

const walletReconcileRoute: FastifyPluginAsync = async (fastify) => {
  // POST /admin/wallet/reconcile
  // Manually credit/reconcile a wallet transaction stuck in 'processing'.
  // WD- (deposit)  + force_status=success  → credit balance
  // WW- (withdraw) + force_status=failed   → refund (re-credit) balance
  // Protected by ADMIN_SECRET header.
  fastify.post<{ Body: ReconcileBody }>(
    '/admin/wallet/reconcile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reference'],
          properties: {
            reference:    { type: 'string', pattern: '^(WD|WW)-' },
            force_status: { type: 'string', enum: ['success', 'failed'] },
          },
        },
      },
    },
    async (request, reply) => {
      const adminSecret = process.env['ADMIN_SECRET'];
      if (!safeSecretEqual(request.headers['x-admin-secret'], adminSecret)) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { reference, force_status } = request.body;

      const { data: tx, error: txErr } = await fastify.supabase
        .from('transactions')
        .select('id, status, wallet_user_id, direction, amount, net_amount')
        .eq('reference', reference)
        .maybeSingle();

      if (txErr) return reply.status(500).send({ error: txErr.message });
      if (!tx)   return reply.status(404).send({ error: `Transaction ${reference} not found` });
      if (!tx.wallet_user_id) return reply.status(400).send({ error: 'No wallet_user_id on transaction' });

      if (tx.status === 'success' || tx.status === 'failed') {
        return reply.send({ ok: true, message: `Already ${tx.status}`, reference });
      }

      const netAmount = Number(tx.net_amount ?? 0);
      const amount    = Number(tx.amount ?? 0);

      // Determine what to do:
      // WD- success  → credit netAmount (deposit confirmed)
      // WW- failed   → refund amount   (withdrawal failed, money not sent)
      const isDeposit    = tx.direction === 'collect';
      const isWithdrawal = tx.direction === 'payout';
      const targetStatus = force_status ?? (isDeposit ? 'success' : 'failed');

      // 1. Update transaction status
      const { error: updateErr } = await fastify.supabase
        .from('transactions')
        .update({ status: targetStatus })
        .eq('id', tx.id);
      if (updateErr) return reply.status(500).send({ error: updateErr.message });

      // 2. Adjust wallet balance
      const { data: walletRow } = await fastify.supabase
        .from('wallet_users')
        .select('balance_cdf')
        .eq('id', tx.wallet_user_id)
        .maybeSingle();
      if (!walletRow) return reply.status(404).send({ error: 'Wallet user not found' });

      let delta = 0;
      let action = 'none';

      if (isDeposit && targetStatus === 'success') {
        delta  = netAmount;  // credit deposit net
        action = 'credited';
      } else if (isWithdrawal && targetStatus === 'failed') {
        delta  = amount;     // refund full amount
        action = 'refunded';
      }

      let newBalance = Number(walletRow.balance_cdf ?? 0);
      if (delta > 0) {
        newBalance += delta;
        const { error: balErr } = await fastify.supabase
          .from('wallet_users')
          .update({ balance_cdf: newBalance })
          .eq('id', tx.wallet_user_id);
        if (balErr) return reply.status(500).send({ error: balErr.message });
      }

      fastify.log.info({ reference, action, delta, newBalance }, '[reconcile] done');

      return reply.send({ ok: true, reference, action, delta, new_balance: newBalance });
    },
  );
};

export default walletReconcileRoute;
