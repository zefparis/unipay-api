import type { FastifyPluginAsync } from 'fastify';

interface AdiRefundBody {
  payment_ref: string;
  reason:      string;
}

/* ── Fastify plugin ─────────────────────────────────────────────────────── */
const adiRefundRoute: FastifyPluginAsync = async (fastify) => {
  /* ────────────────────────────────────────────────────────────────────────
   * POST /v1/adi/credit-failed-refund
   * Auth: HMAC X-PredictStreet-Signature (TODO: re-enable before go-live)
   * ──────────────────────────────────────────────────────────────────────── */
  fastify.post<{ Body: AdiRefundBody }>(
    '/adi/credit-failed-refund',
    {
      schema: {
        body: {
          type: 'object',
          required: ['payment_ref', 'reason'],
          properties: {
            payment_ref: { type: 'string' },
            reason:      { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { payment_ref, reason } = request.body;

      // TODO: re-enable HMAC verification before go-live
      // const sig = request.headers['x-predictstreet-signature'] as string ?? '';
      // if (!verifyHmacSignature(...)) return reply.status(401).send({ ok: false });

      /* ── 1. Find transaction by reference ───────────────────────────── */
      const { data: tx, error } = await fastify.supabase
        .from('transactions')
        .select('id, status, reference')
        .eq('reference', payment_ref)
        .maybeSingle();

      if (error) {
        fastify.log.error({ err: error, payment_ref }, '[adi-refund] DB lookup error');
        return reply.status(500).send({ ok: false, error: 'db_error' });
      }

      if (!tx) {
        fastify.log.warn({ payment_ref }, '[adi-refund] transaction not found');
        return reply.status(404).send({ ok: false, error: 'transaction_not_found' });
      }

      /* ── 2. Idempotency: already refunded ───────────────────────────── */
      if (tx.status === 'refunded') {
        fastify.log.info({ payment_ref }, '[adi-refund] already refunded — returning 200');
        return reply.send({ ok: true, status: 'already_refunded', payment_ref });
      }

      /* ── 3. Log the refund request (no CDF credit yet — TBD) ─────────── */
      fastify.log.info(
        { payment_ref, reason, tx_id: tx.id, tx_status: tx.status },
        '[adi-refund] refund request acknowledged (CDF credit TBD)',
      );

      /* ── 4. Return acknowledgement ───────────────────────────────────── */
      return reply.send({ ok: true, payment_ref, reason });
    },
  );
};

export default adiRefundRoute;
