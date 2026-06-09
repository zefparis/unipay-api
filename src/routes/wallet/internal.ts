import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';

interface CreditBody {
  phone:        string;
  cglt_amount:  number;
  tx_hash:      string;
  bsc_address:  string;
}

const walletInternalRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/internal/bsc-addresses ─────────────────────── */
  fastify.get(
    '/internal/bsc-addresses',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (request.headers['x-api-key'] !== env.GAMING_API_KEY) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const { data, error } = await fastify.supabase
        .from('wallet_users')
        .select('phone, blockchain_address')
        .not('blockchain_address', 'is', null);
      if (error) {
        fastify.log.error({ err: error }, '[internal] bsc-addresses fetch failed');
        return reply.status(500).send({ error: 'Database error' });
      }
      return reply.send(data);
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
      if (request.headers['x-api-key'] !== env.GAMING_API_KEY) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { phone, cglt_amount, tx_hash, bsc_address } = request.body;

      // Idempotence — vérifie si la tx est déjà traitée
      const { data: existing } = await fastify.supabase
        .from('transactions')
        .select('id')
        .eq('blockchain_tx_hash', tx_hash)
        .maybeSingle();

      if (existing) {
        return reply.send({ success: true, already_processed: true });
      }

      // Retrouver le wallet par adresse BSC
      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, cglt_balance')
        .eq('blockchain_address', bsc_address)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      const newBalance = Number(wallet.cglt_balance ?? 0) + cglt_amount;

      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newBalance })
        .eq('id', wallet.id);

      await fastify.supabase.from('transactions').insert({
        id:                 crypto.randomUUID(),
        wallet_user_id:     wallet.id,
        operator:           'cglt',
        direction:          'collect',
        amount:             cglt_amount,
        fee:                0,
        net_amount:         cglt_amount,
        currency:           'CGLT',
        phone,
        reference:          `WCGLT-IN-${tx_hash.slice(0, 8).toUpperCase()}`,
        blockchain_tx_hash: tx_hash,
        cglt_amount,
        status:             'success',
        metadata:           { source: 'wcglt_incoming', bsc_address },
      });

      fastify.log.info({ walletId: wallet.id, phone, cglt_amount, tx_hash }, '[internal] CGLT credited from incoming wCGLT');

      return reply.send({ success: true, new_balance: newBalance });
    },
  );
};

export default walletInternalRoute;
