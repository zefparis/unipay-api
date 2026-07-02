import type { FastifyPluginAsync } from 'fastify';

const adminPredictStreetRoute: FastifyPluginAsync = async (fastify) => {
  /* ────────────────────────────────────────────────────────────────────────
   * GET /v1/admin/predictstreet/transactions
   * Returns last 10 transactions where reference starts with 'ps-dep-'
   * plus aggregate stats (total, success count, total CDF, success rate).
   * ──────────────────────────────────────────────────────────────────────── */
  fastify.get('/admin/predictstreet/transactions', async (request, reply) => {
    if (!request.isAdmin) {
      return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
    }

    // Fetch last 10 ps-dep- transactions for the table
    const { data: rows, error: rowErr } = await fastify.supabase
      .from('transactions')
      .select('id, reference, amount, net_amount, currency, status, created_at')
      .ilike('reference', 'ps-dep-%')
      .order('created_at', { ascending: false })
      .limit(10);

    if (rowErr) {
      fastify.log.error({ err: rowErr }, '[admin/predictstreet] transactions query failed');
      return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
    }

    // Aggregate stats across all ps-dep- transactions
    const { data: allRows, error: aggErr } = await fastify.supabase
      .from('transactions')
      .select('status, net_amount')
      .ilike('reference', 'ps-dep-%');

    if (aggErr) {
      fastify.log.error({ err: aggErr }, '[admin/predictstreet] aggregate query failed');
      return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
    }

    const total         = allRows?.length ?? 0;
    const successRows   = allRows?.filter((r) => r.status === 'success') ?? [];
    const successCount  = successRows.length;
    const totalCdf      = successRows.reduce((sum, r) => sum + Number(r.net_amount ?? 0), 0);
    const successRate   = total > 0 ? Math.round((successCount / total) * 100) : 0;

    // Last successful webhook
    const lastSuccess = rows?.find((r) => r.status === 'success') ?? null;

    return {
      transactions: rows ?? [],
      stats: {
        total,
        success_count:  successCount,
        total_cdf:      totalCdf,
        success_rate:   successRate,
      },
      last_webhook: lastSuccess,
    };
  });
};

export default adminPredictStreetRoute;
