import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';
import { BridgeOutcomeUnknownError, mintWCGLT } from '../../services/bridge';
import { isCgltBlockchainWriteEnabled } from '../../config/cglt-blockchain-mode';
import { checkDestinationAddress } from '../../lib/address-guard';

const CGLT_PER_WCGLT = parseInt(process.env.CGLT_PER_WCGLT ?? '500', 10);

interface SwapBody {
  cglt_amount: number;
  bsc_recipient: string;
}

const wcgltSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SwapBody }>(
    '/wallet/wcglt-to-usdt',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cglt_amount', 'bsc_recipient'],
          properties: {
            cglt_amount:   { type: 'number', minimum: 1 },
            bsc_recipient: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const payload = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const amountCglt = Math.trunc(Number(request.body.cglt_amount));
      if (!Number.isFinite(amountCglt) || amountCglt < CGLT_PER_WCGLT) {
        return reply.status(400).send({ error: 'invalid_amount', min: CGLT_PER_WCGLT });
      }
      if (amountCglt % CGLT_PER_WCGLT !== 0) {
        return reply.status(400).send({ error: 'amount_not_multiple', multiple: CGLT_PER_WCGLT });
      }

      const bscAddress = request.body.bsc_recipient.trim();

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, cglt_balance')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet) {
        return reply.status(404).send({ error: 'wallet_not_found' });
      }

      const cgltBalance  = Number(wallet.cglt_balance ?? 0);
      if (amountCglt > cgltBalance) {
        return reply.status(402).send({ error: 'insufficient_cglt', available: cgltBalance });
      }

      const wcgltReceived = amountCglt / CGLT_PER_WCGLT;
      const orderId       = crypto.randomUUID();
      const reference     = `WCS-${orderId.slice(0, 8).toUpperCase()}`;

      // blockchain_required — 503 avant toute modification DB
      if (!isCgltBlockchainWriteEnabled()) {
        return reply.status(503).send({ error: 'CGLT_BLOCKCHAIN_DISABLED', message: 'Bridge operations are disabled' });
      }

      /* ── Destination address guard (forbidden + contract detection) ── */
      const guard = await checkDestinationAddress(bscAddress, fastify.supabase);
      if (!guard.ok) {
        fastify.log.warn({ walletId: payload.wallet_id, bsc_recipient: bscAddress }, '[wcglt-swap] bridge blocked — address guard');
        return reply.status(guard.status).send(guard.body);
      }

      // Debit CGLT before bridge call
      const { data: debitedBalance, error: debitError } = await fastify.supabase.rpc(
        'begin_wcglt_onchain_operation',
        {
          p_operation_id: orderId,
          p_user_id: payload.wallet_id,
          p_amount_debited: amountCglt,
          p_amount_onchain: wcgltReceived,
          p_recipient: bscAddress,
          p_reference: reference,
          p_source: 'wallet_wcglt_swap',
          p_operator: 'wcglt_swap',
          p_direction: 'swap',
          p_phone: wallet.phone,
          p_metadata: { wcglt_received: wcgltReceived },
        },
      );
      if (debitError) {
        const isInsufficient = debitError.message?.includes('INSUFFICIENT_CGLT');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'insufficient_cglt' : 'cglt_debit_failed',
        });
      }
      const newBalance = Number(debitedBalance);

      // Bridge: mint wCGLT on BSC to user's address
      let txHash: string;
      try {
        txHash = await mintWCGLT(bscAddress, amountCglt, orderId);
      } catch (e) {
        if (e instanceof BridgeOutcomeUnknownError) {
          await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
            p_operation_id: orderId,
            p_tx_hash: null,
            p_reason: e.message,
          });
          fastify.log.warn({ err: e, operationId: orderId }, '[wcglt-swap] bridge outcome pending verification');
          return reply.status(202).send({
            success: false,
            status: 'pending_onchain_check',
            operation_id: orderId,
            new_balance: newBalance,
          });
        }

        await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
          p_operation_id: orderId,
          p_outcome: 'failed',
          p_tx_hash: null,
          p_reason: e instanceof Error ? e.message : 'bridge_failed',
        });
        fastify.log.error({ err: e }, '[wcglt-swap] bridge failed before broadcast — CGLT refunded');
        return reply.status(502).send({ error: 'bridge_failed' });
      }

      const { error: finalizeError } = await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
        p_operation_id: orderId,
        p_outcome: 'confirmed',
        p_tx_hash: txHash,
        p_reason: null,
      });
      if (finalizeError) {
        await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
          p_operation_id: orderId,
          p_tx_hash: txHash,
          p_reason: 'DATABASE_FINALIZATION_UNCERTAIN',
        });
        fastify.log.error({ err: finalizeError, operationId: orderId, txHash }, '[wcglt-swap] on-chain mint requires reconciliation');
        return reply.status(202).send({
          success: false,
          status: 'pending_onchain_check',
          operation_id: orderId,
          bsc_tx_hash: txHash,
          new_balance: newBalance,
        });
      }

      fastify.log.info(
        { walletId: payload.wallet_id, amountCglt, wcgltReceived, txHash },
        '[wcglt-swap] completed',
      );

      return reply.status(201).send({
        success:       true,
        cglt_spent:    amountCglt,
        wcglt_swapped: wcgltReceived,
        usdt_received: wcgltReceived,
        new_balance: newBalance,
        bsc_tx_hash:   txHash,
        bsc_recipient: bscAddress,
      });
    },
  );
};

export default wcgltSwapRoute;
