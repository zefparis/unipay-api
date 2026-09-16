import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { createUserWallet } from '../../services/cdp';
import { getWcgltDepositProcessor } from '../../config/cglt-blockchain-mode';
import { matchesAnySecret, safeSecretEqual } from '../../security/secret-compare';
import { runMerchantInactivitySweep } from '../../lib/merchant-inactivity-sweep.js';

interface CreditBody {
  phone:        string;
  cglt_amount:  number;
  tx_hash:      string;
  bsc_address:  string;
}

const walletInternalRoute: FastifyPluginAsync = async (fastify) => {

  /**
   * Bridge inbound auth — trust boundary 2.
   * Accepts BRIDGE_INBOUND_API_KEY (new) or GAMING_API_KEY (legacy fallback).
   * Never accepts CONGOGAMING_API_KEY.
   */
  function requireBridgeInboundKey(request: FastifyRequest, reply: FastifyReply): boolean {
    const newKey = env.BRIDGE_INBOUND_API_KEY;
    const legacyKey = env.GAMING_API_KEY;

    if (!newKey && !legacyKey) {
      reply.status(500).send({ error: 'Bridge integration not configured' });
      return false;
    }

    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string' || !matchesAnySecret(provided, [newKey, legacyKey])) {
      reply.status(401).send({ error: 'Unauthorized' });
      return false;
    }

    if (newKey && legacyKey && !matchesAnySecret(provided, [newKey]) && matchesAnySecret(provided, [legacyKey])) {
      request.log.warn({ boundary: 'bridge_to_unipay' }, '[LEGACY_API_KEY_USED]');
    }

    return true;
  }

  /* ── GET /v1/internal/bsc-addresses ─────────────────────── */
  // M10: pagination is now mandatory (limit + offset).
  // If absent → 400. Response: { data, total, has_more }.
  // This prevents dumping ALL phone numbers + blockchain addresses
  // in a single unbounded response.
  fastify.get<{
    Querystring: { limit?: string; offset?: string };
  }>(
    '/internal/bsc-addresses',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!requireBridgeInboundKey(request, reply)) return;

      // M10: mandatory pagination
      const { limit: limitStr, offset: offsetStr } = request.query;
      if (limitStr === undefined || offsetStr === undefined) {
        fastify.log.warn(
          { ip: request.ip, userAgent: request.headers['user-agent'], hasLimit: limitStr !== undefined, hasOffset: offsetStr !== undefined },
          '[internal/bsc-addresses] 400 — missing pagination params',
        );
        return reply.status(400).send({
          error: 'PAGINATION_REQUIRED',
          message: 'limit and offset query parameters are required. limit max 500.',
          statusCode: 400,
        });
      }

      const limit = parseInt(limitStr, 10);
      const offset = parseInt(offsetStr, 10);

      if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 1 || offset < 0) {
        return reply.status(400).send({
          error: 'INVALID_PAGINATION',
          message: 'limit must be >= 1, offset must be >= 0.',
          statusCode: 400,
        });
      }

      if (limit > 500) {
        return reply.status(400).send({
          error: 'LIMIT_EXCEEDED',
          message: 'limit must be <= 500.',
          statusCode: 400,
        });
      }

      // M10: distinct application log for each call (monitor 400s after deploy)
      fastify.log.info(
        { ip: request.ip, userAgent: request.headers['user-agent'], limit, offset },
        '[internal/bsc-addresses] paginated query',
      );

      const { data, error, count } = await fastify.supabase
        .from('wallet_users')
        .select('phone, blockchain_address', { count: 'exact' })
        .not('blockchain_address', 'is', null)
        .range(offset, offset + limit - 1);

      if (error) {
        fastify.log.error({ err: error }, '[internal] bsc-addresses fetch failed');
        return reply.status(500).send({ error: 'Database error' });
      }
      const normalized = (data ?? []).map((row) => ({
        ...row,
        blockchain_address: row.blockchain_address?.toLowerCase() ?? null,
      }));
      const total = count ?? 0;
      const hasMore = offset + limit < total;
      return reply.send({ data: normalized, total, has_more: hasMore });
    },
  );

  /* ── POST /v1/wallet/cglt-credit-incoming ───────────────── */
  fastify.post<{ Body: CreditBody }>(
    '/wallet/cglt-credit-incoming',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'cglt_amount', 'tx_hash', 'bsc_address'],
          properties: {
            phone:       { type: 'string' },
            cglt_amount: { type: 'number', minimum: 1 },
            tx_hash:     { type: 'string' },
            bsc_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireBridgeInboundKey(request, reply)) return;

      const { phone, cglt_amount, tx_hash } = request.body;
      const bsc_address = request.body.bsc_address.toLowerCase();

      // Feature flag: only process if bridge processor is active
      const processor = getWcgltDepositProcessor();
      if (processor !== 'bridge') {
        return reply.status(503).send({
          error: 'WCGLT_DEPOSIT_PROCESSOR_DISABLED',
          message: `Deposit processor is '${processor}', expected 'bridge'`,
        });
      }

      // Retrouver le wallet par adresse BSC
      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, cglt_balance')
        .ilike('blockchain_address', bsc_address)  // case-insensitive match
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      const { data: result, error: processError } = await fastify.supabase.rpc(
        'process_bridge_incoming_credit',
        {
          p_transaction_id: crypto.randomUUID(),
          p_user_id: wallet.id,
          p_phone: phone,
          p_cglt_amount: cglt_amount,
          p_tx_hash: tx_hash,
          p_bsc_address: bsc_address,
        },
      );
      if (processError) {
        fastify.log.error({ err: processError, walletId: wallet.id }, '[internal] atomic CGLT credit failed');
        return reply.status(500).send({ error: 'credit_failed' });
      }

      const processResult = result as { processed?: boolean; duplicate?: boolean; new_balance?: number } | null;
      if (!processResult?.processed) {
        return reply.send({ success: true, already_processed: true });
      }

      fastify.log.info({ walletId: wallet.id, phone, cglt_amount, tx_hash }, '[internal] CGLT credited from incoming wCGLT');

      return reply.send({ success: true, new_balance: Number(processResult.new_balance) });
    },
  );
  /* ── POST /v1/internal/backfill-cdp-wallets ────────────── */
  fastify.post(
    '/internal/backfill-cdp-wallets',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Accept either ADMIN_SECRET or CRON_SERVICE_SECRET (same as hmac.ts)
      const adminSecret = process.env.ADMIN_SECRET;
      const cronSecret = process.env.CRON_SERVICE_SECRET;
      if (!safeSecretEqual(request.headers['x-admin-secret'], adminSecret) &&
          !safeSecretEqual(request.headers['x-admin-secret'], cronSecret)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const { data: users, error } = await fastify.supabase
        .from('wallet_users')
        .select('id')
        .is('cdp_wallet_address', null)
        .limit(50);

      if (error) {
        fastify.log.error({ err: error }, '[backfill] query failed');
        return reply.status(500).send({ error: 'Database error' });
      }

      let processed = 0;
      let errors = 0;

      for (const user of users ?? []) {
        try {
          const address = await createUserWallet(user.id);
          await fastify.supabase
            .from('wallet_users')
            .update({ cdp_wallet_address: address })
            .eq('id', user.id);
          processed++;
          fastify.log.info({ userId: user.id, address }, '[backfill] CDP wallet created');
        } catch (err) {
          errors++;
          fastify.log.error({ err, userId: user.id }, '[backfill] CDP wallet creation failed');
        }
      }

      return reply.send({
        ok: true,
        processed,
        errors,
        remaining: (users?.length ?? 0) === 50 ? 'more' : 'none',
      });
    },
  );

  /* ── POST /v1/internal/merchant-inactivity-sweep ─────────── */
  /* Daily cron: classify merchants by activity, send reminders, soft-delete.
   * Auth: ADMIN_SECRET or CRON_SERVICE_SECRET (same as backfill). */
  fastify.post(
    '/internal/merchant-inactivity-sweep',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const adminSecret = process.env.ADMIN_SECRET;
      const cronSecret = process.env.CRON_SERVICE_SECRET;
      if (!safeSecretEqual(request.headers['x-admin-secret'], adminSecret) &&
          !safeSecretEqual(request.headers['x-admin-secret'], cronSecret)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      try {
        const result = await runMerchantInactivitySweep(fastify.supabase);
        fastify.log.info(
          {
            scanned: result.scanned,
            eligible: result.eligible,
            reminders_sent: result.reminders_sent,
            status_changes: result.status_changes,
            soft_deletes: result.soft_deletes,
            reactivations: result.reactivations,
            errors: result.errors,
          },
          '[inactivity-sweep] done',
        );
        return reply.send({ ok: true, ...result });
      } catch (err) {
        fastify.log.error({ err }, '[inactivity-sweep] fatal error');
        return reply.status(500).send({ error: 'Sweep failed', detail: (err as Error).message });
      }
    },
  );
};

export default walletInternalRoute;
