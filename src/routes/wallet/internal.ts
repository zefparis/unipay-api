import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { createUserWallet } from '../../services/cdp';
import { getWcgltDepositProcessor } from '../../config/cglt-blockchain-mode';
import { matchesAnySecret, safeSecretEqual } from '../../security/secret-compare';

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
  fastify.get(
    '/internal/bsc-addresses',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!requireBridgeInboundKey(request, reply)) return;
      const { data, error } = await fastify.supabase
        .from('wallet_users')
        .select('phone, blockchain_address')
        .not('blockchain_address', 'is', null);
      if (error) {
        fastify.log.error({ err: error }, '[internal] bsc-addresses fetch failed');
        return reply.status(500).send({ error: 'Database error' });
      }
      const normalized = (data ?? []).map((row) => ({
        ...row,
        blockchain_address: row.blockchain_address?.toLowerCase() ?? null,
      }));
      return reply.send(normalized);
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
      const adminSecret = process.env.ADMIN_SECRET;
      if (!safeSecretEqual(request.headers['x-admin-secret'], adminSecret)) {
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
};

export default walletInternalRoute;
