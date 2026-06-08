import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { mintCGLT, getSwapRate } from '../../services/blockchain';

interface DebitBody {
  phone: string;
  amount: number;
  game_ref: string;
}

interface CreditBody {
  phone: string;
  amount: number;
  game_ref: string;
  tx_ref: string;
}

interface BalanceQuery {
  phone: string;
}

/** Shared-secret guard for Congo Gaming ↔ UniPay server-to-server calls. */
function requireGamingKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = env.GAMING_API_KEY;
  if (!expected) {
    reply.status(500).send({ error: 'Gaming integration not configured', statusCode: 500 });
    return false;
  }
  const provided = request.headers['x-api-key'];
  if (!provided || provided !== expected) {
    reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
    return false;
  }
  return true;
}

const cgltGamingRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/cglt-debit — place a CGLT bet ─────────── */
  fastify.post<{ Body: DebitBody }>(
    '/wallet/cglt-debit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'amount', 'game_ref'],
          properties: {
            phone:    { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            amount:   { type: 'number', minimum: 0.01 },
            game_ref: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireGamingKey(request, reply)) return;

      const { phone, amount, game_ref } = request.body;

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, is_active, cglt_balance')
        .eq('phone', phone)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'WALLET_NOT_FOUND', statusCode: 404 });
      }
      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      if (cgltBalance < amount) {
        return reply.status(402).send({
          error:        'INSUFFICIENT_CGLT',
          cglt_balance: cgltBalance,
          required:     amount,
          statusCode:   402,
        });
      }

      const newBalance = cgltBalance - amount;
      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newBalance })
        .eq('id', wallet.id);

      const txId   = crypto.randomUUID();
      const txRef  = `GAME-${txId.slice(0, 8).toUpperCase()}`;

      await fastify.supabase.from('transactions').insert({
        id:             txId,
        wallet_user_id: wallet.id,
        operator:       'cglt',
        direction:      'cglt_gaming_debit',
        amount,
        fee:            0,
        net_amount:     amount,
        currency:       'CGLT',
        phone:          wallet.phone,
        reference:      txRef,
        game_ref,
        cglt_amount:    -amount,
        status:         'success',
        metadata:       { source: 'congogaming', game_ref },
      });

      fastify.log.info({ walletId: wallet.id, amount, game_ref, txRef }, '[gaming] CGLT debit');

      return reply.status(201).send({
        success:     true,
        new_balance: newBalance,
        tx_ref:      txRef,
      });
    },
  );

  /* ── POST /v1/wallet/cglt-credit — pay out CGLT winnings ───── */
  fastify.post<{ Body: CreditBody }>(
    '/wallet/cglt-credit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'amount', 'game_ref', 'tx_ref'],
          properties: {
            phone:    { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            amount:   { type: 'number', minimum: 0.01 },
            game_ref: { type: 'string', minLength: 1, maxLength: 128 },
            tx_ref:   { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireGamingKey(request, reply)) return;

      const { phone, amount, game_ref, tx_ref } = request.body;

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, is_active, cglt_balance, blockchain_address')
        .eq('phone', phone)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'WALLET_NOT_FOUND', statusCode: 404 });
      }
      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const newBalance = Number(wallet.cglt_balance ?? 0) + amount;
      await fastify.supabase
        .from('wallet_users')
        .update({ cglt_balance: newBalance })
        .eq('id', wallet.id);

      // ── Mint CGLT on-chain (best-effort; ledger credit already done) ──
      let blockchainTxHash: string | null = null;
      if (wallet.blockchain_address) {
        try {
          blockchainTxHash = await mintCGLT(wallet.blockchain_address, amount, tx_ref);
        } catch (err) {
          fastify.log.error({ err, walletId: wallet.id, amount, tx_ref }, '[gaming] CGLT mint failed');
        }
      }

      await fastify.supabase.from('transactions').insert({
        id:                 crypto.randomUUID(),
        wallet_user_id:     wallet.id,
        operator:           'cglt',
        direction:          'cglt_gaming_credit',
        amount,
        fee:                0,
        net_amount:         amount,
        currency:           'CGLT',
        phone:              wallet.phone,
        reference:          tx_ref,
        game_ref,
        cglt_amount:        amount,
        blockchain_tx_hash: blockchainTxHash,
        status:             'success',
        metadata:           { source: 'congogaming', game_ref, tx_ref },
      });

      fastify.log.info({ walletId: wallet.id, amount, game_ref, tx_ref, blockchainTxHash }, '[gaming] CGLT credit');

      return reply.status(201).send({
        success:            true,
        new_balance:        newBalance,
        blockchain_tx_hash: blockchainTxHash,
      });
    },
  );

  /* ── GET /v1/wallet/cglt-balance?phone=+243... ─────────────── */
  fastify.get<{ Querystring: BalanceQuery }>(
    '/wallet/cglt-balance',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['phone'],
          properties: {
            phone: { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireGamingKey(request, reply)) return;

      const { phone } = request.query;

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('phone, cglt_balance')
        .eq('phone', phone)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'WALLET_NOT_FOUND', statusCode: 404 });
      }

      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      let equivalentUsdt: number | null = null;
      try {
        const { rate } = await getSwapRate();
        if (rate > 0) equivalentUsdt = cgltBalance / rate;
      } catch (err) {
        fastify.log.warn({ err }, '[gaming] swap rate unavailable for equivalent_usdt');
      }

      return {
        phone:           wallet.phone,
        cglt_balance:    cgltBalance,
        equivalent_usdt: equivalentUsdt,
      };
    },
  );
};

export default cgltGamingRoute;
