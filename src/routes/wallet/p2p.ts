import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

interface SendBody {
  recipient_phone: string;
  amount: number;
  note?: string;
}

const walletP2PRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SendBody }>(
    '/wallet/send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['recipient_phone', 'amount'],
          properties: {
            recipient_phone: { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            amount:          { type: 'number', minimum: 1 },
            note:            { type: 'string', maxLength: 255 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              transfer_id:       { type: 'string' },
              sender_tx_id:      { type: 'string' },
              recipient_tx_id:   { type: 'string' },
              amount:            { type: 'number' },
              currency:          { type: 'string' },
              recipient_phone:   { type: 'string' },
              recipient_name:    { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!walletPayload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { recipient_phone, amount, note } = request.body;
      const senderWalletId = walletPayload.wallet_id;

      // Prevent self-transfer
      if (walletPayload.phone === recipient_phone) {
        return reply.status(400).send({ error: 'Cannot send to yourself', statusCode: 400 });
      }

      // Fetch sender wallet
      const { data: sender } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, balance_cdf, is_active')
        .eq('id', senderWalletId)
        .maybeSingle();

      if (!sender?.is_active) {
        return reply.status(403).send({ error: 'Sender account is suspended', statusCode: 403 });
      }

      const senderBalance = Number(sender.balance_cdf ?? 0);

      if (senderBalance < amount) {
        return reply.status(402).send({
          error:        'Insufficient balance',
          balance_cdf:  senderBalance,
          required_cdf: amount,
          statusCode:   402,
        });
      }

      // Fetch recipient wallet
      const { data: recipient } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, full_name, balance_cdf, is_active')
        .eq('phone', recipient_phone)
        .maybeSingle();

      if (!recipient) {
        return reply.status(404).send({ error: 'Recipient wallet not found', statusCode: 404 });
      }

      if (!recipient.is_active) {
        return reply.status(403).send({ error: 'Recipient account is suspended', statusCode: 403 });
      }

      // ── Atomic P2P transfer via RPC ──────────────────────────
      const { error: transferError } = await fastify.supabase
        .rpc('wallet_p2p', { p_sender_id: senderWalletId, p_receiver_id: recipient.id, p_amount: amount });

      if (transferError) {
        const isInsufficient = transferError.message?.includes('INSUFFICIENT_FUNDS');
        return reply.status(isInsufficient ? 402 : 500).send({
          error:      isInsufficient ? 'Insufficient balance' : 'Transfer failed',
          statusCode: isInsufficient ? 402 : 500,
        });
      }

      // ── Insert 2 transaction rows ─────────────────────────────
      const transferId   = crypto.randomUUID();
      const senderTxId   = crypto.randomUUID();
      const recipientTxId = crypto.randomUUID();
      const reference    = `P2P-${transferId.slice(0, 8).toUpperCase()}`;

      const p2pMeta = { transfer_id: transferId, note: note ?? null };

      await fastify.supabase.from('transactions').insert([
        {
          id:             senderTxId,
          wallet_user_id: senderWalletId,
          operator:       'orange',       // placeholder — P2P is off-chain
          direction:      'p2p',
          amount,
          fee:            0,
          net_amount:     amount,
          currency:       'CDF',
          phone:          recipient_phone,
          reference,
          status:         'success',
          metadata:       { ...p2pMeta, side: 'sender' },
        },
        {
          id:             recipientTxId,
          wallet_user_id: recipient.id,
          operator:       'orange',       // placeholder — P2P is off-chain
          direction:      'p2p',
          amount,
          fee:            0,
          net_amount:     amount,
          currency:       'CDF',
          phone:          sender.phone,
          reference,
          status:         'success',
          metadata:       { ...p2pMeta, side: 'recipient' },
        },
      ]);

      fastify.log.info({ transferId, senderWalletId, recipientId: recipient.id, amount }, 'P2P transfer done');

      return reply.status(201).send({
        transfer_id:     transferId,
        sender_tx_id:    senderTxId,
        recipient_tx_id: recipientTxId,
        amount,
        currency:        'CDF',
        recipient_phone,
        recipient_name:  recipient.full_name ?? null,
      });
    },
  );
};

export default walletP2PRoute;
