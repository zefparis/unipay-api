import type { FastifyPluginAsync } from 'fastify';
import { safeSecretEqual } from '../../security/secret-compare';
import { logAdminAction } from '../../lib/admin-action-log.js';

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

      // Fetch the transaction (read-only — the atomic RPC locks + updates)
      const { data: tx, error: txErr } = await fastify.supabase
        .from('transactions')
        .select('id, status, wallet_user_id, direction, amount, net_amount')
        .eq('reference', reference)
        .maybeSingle();

      if (txErr) return reply.status(500).send({ error: txErr.message });
      if (!tx)   return reply.status(404).send({ error: `Transaction ${reference} not found` });
      if (!tx.wallet_user_id) return reply.status(400).send({ error: 'No wallet_user_id on transaction' });

      const netAmount = Number(tx.net_amount ?? 0);
      const amount    = Number(tx.amount ?? 0);

      // Determine what to do:
      // WD- success  → credit netAmount (deposit confirmed)
      // WW- failed   → refund amount   (withdrawal failed, money not sent)
      const isDeposit    = tx.direction === 'collect';
      const isWithdrawal = tx.direction === 'payout';
      const targetStatus = force_status ?? (isDeposit ? 'success' : 'failed');

      let delta = 0;
      if (isDeposit && targetStatus === 'success') {
        delta = netAmount;  // credit deposit net
      } else if (isWithdrawal && targetStatus === 'failed') {
        delta = amount;     // refund full amount
      }

      // ── Atomic reconcile (M4): status update + balance credit in one RPC ──
      // The RPC locks the transaction row (FOR UPDATE), checks if already
      // terminal (idempotent no-op), updates status, and credits the wallet
      // — all in a single transaction. Two concurrent calls cannot both
      // credit: the first commits, the second finds the row already terminal.
      const { data: result, error: rpcErr } = await fastify.supabase
        .rpc('wallet_reconcile_atomic', {
          p_tx_id: tx.id,
          p_target_status: targetStatus,
          p_delta: delta,
        });

      if (rpcErr) {
        const msg = rpcErr.message ?? '';
        if (msg.includes('TRANSACTION_NOT_FOUND')) {
          return reply.status(404).send({ error: `Transaction ${reference} not found` });
        }
        if (msg.includes('WALLET_NOT_FOUND')) {
          return reply.status(404).send({ error: 'Wallet user not found' });
        }
        if (msg.includes('INVALID_TARGET_STATUS')) {
          return reply.status(400).send({ error: msg });
        }
        return reply.status(500).send({ error: msg });
      }

      const r = result as { already_terminal: boolean; previous_status?: string; new_status?: string; action?: string; delta?: number; new_balance?: number | null };

      // Idempotent: already terminal — no double-credit
      if (r.already_terminal) {
        return reply.send({
          ok: true,
          message: `Already ${r.previous_status}`,
          reference,
          already_terminal: true,
        });
      }

      const action = r.action ?? 'none';
      const newBalance = r.new_balance !== null && r.new_balance !== undefined ? Number(r.new_balance) : undefined;

      fastify.log.info({ reference, action, delta, newBalance, previous_status: r.previous_status, new_status: r.new_status }, '[reconcile] done (atomic)');

      void logAdminAction(
        fastify.supabase,
        'wallet.reconcile',
        'transaction',
        tx.id,
        { reference, previous_status: r.previous_status, new_status: r.new_status, action, delta, new_balance: newBalance, wallet_user_id: tx.wallet_user_id },
        fastify.log,
      );

      return reply.send({ ok: true, reference, action, delta, new_balance: newBalance });
    },
  );
};

export default walletReconcileRoute;
