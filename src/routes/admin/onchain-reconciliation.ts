import type { FastifyPluginAsync } from 'fastify';
import { verifyUsdtWithdrawal, verifyWcgltMint } from '../../lib/bsc-withdrawal';

interface ResolveBody {
  resource_type: 'usdt_withdrawal' | 'wcglt_operation';
  id: string;
  tx_hash: string;
}

const adminOnchainReconciliationRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/onchain-reconciliation/pending', async (request, reply) => {
    if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

    const [withdrawals, operations] = await Promise.all([
      fastify.supabase
        .from('withdrawal_requests')
        .select('id, user_id, amount, fee, network, destination_address, tx_hash, failure_reason, created_at, updated_at')
        .eq('status', 'pending_onchain_check')
        .order('created_at', { ascending: true })
        .limit(100),
      fastify.supabase
        .from('onchain_operations')
        .select('id, kind, wallet_user_id, amount_debited, amount_onchain, recipient, reference, source, tx_hash, failure_reason, created_at, updated_at')
        .eq('status', 'pending_onchain_check')
        .order('created_at', { ascending: true })
        .limit(100),
    ]);

    if (withdrawals.error || operations.error) {
      fastify.log.error({ withdrawalError: withdrawals.error, operationError: operations.error }, '[admin-onchain] pending query failed');
      return reply.status(500).send({ error: 'Failed to list pending on-chain operations' });
    }

    return reply.send({
      usdt_withdrawals: withdrawals.data ?? [],
      wcglt_operations: operations.data ?? [],
    });
  });

  fastify.post<{ Body: ResolveBody }>(
    '/admin/onchain-reconciliation/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['resource_type', 'id', 'tx_hash'],
          properties: {
            resource_type: { type: 'string', enum: ['usdt_withdrawal', 'wcglt_operation'] },
            id: { type: 'string', format: 'uuid' },
            tx_hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!request.isAdmin) return reply.status(403).send({ error: 'Admin access required' });

      const { resource_type, id, tx_hash } = request.body;
      if (resource_type === 'usdt_withdrawal') {
        const { data: row } = await fastify.supabase
          .from('withdrawal_requests')
          .select('id, amount, fee, destination_address, status')
          .eq('id', id)
          .maybeSingle();
        if (!row) return reply.status(404).send({ error: 'Withdrawal not found' });
        if (row.status !== 'pending_onchain_check') {
          return reply.send({ resolved: false, already_terminal: true, status: row.status });
        }

        const status = await verifyUsdtWithdrawal(
          tx_hash,
          row.destination_address,
          Number(row.amount) - Number(row.fee ?? 0),
        );
        if (status === 'pending' || status === 'mismatch') {
          return reply.status(409).send({ resolved: false, onchain_status: status });
        }

        const { data, error } = await fastify.supabase.rpc('resolve_usdt_withdrawal_onchain', {
          p_withdrawal_id: id,
          p_outcome: status,
          p_tx_hash: tx_hash,
          p_reason: status === 'failed' ? 'ADMIN_VERIFIED_FAILED_RECEIPT' : null,
        });
        if (error) return reply.status(500).send({ error: 'Resolution failed' });
        return reply.send({ resolved: true, onchain_status: status, result: data });
      }

      const { data: row } = await fastify.supabase
        .from('onchain_operations')
        .select('id, amount_onchain, recipient, status')
        .eq('id', id)
        .maybeSingle();
      if (!row) return reply.status(404).send({ error: 'On-chain operation not found' });
      if (row.status !== 'pending_onchain_check') {
        return reply.send({ resolved: false, already_terminal: true, status: row.status });
      }

      const status = await verifyWcgltMint(tx_hash, row.recipient, Number(row.amount_onchain));
      if (status === 'pending' || status === 'mismatch') {
        return reply.status(409).send({ resolved: false, onchain_status: status });
      }

      const { data, error } = await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
        p_operation_id: id,
        p_outcome: status,
        p_tx_hash: tx_hash,
        p_reason: status === 'failed' ? 'ADMIN_VERIFIED_FAILED_RECEIPT' : null,
      });
      if (error) return reply.status(500).send({ error: 'Resolution failed' });
      return reply.send({ resolved: true, onchain_status: status, result: data });
    },
  );
};

export default adminOnchainReconciliationRoute;
