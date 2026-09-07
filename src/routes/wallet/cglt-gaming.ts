import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../../config/env';
import { mintCGLT, getSwapRate } from '../../services/blockchain';
import { BridgeOutcomeUnknownError, mintWCGLT } from '../../services/bridge';
import { requireActiveWallet, walletIdFromRequest } from '../../lib/wallet-auth';
import { findOrCreateWalletByPhone } from '../../utils/wallet-provision';
import { isCgltBlockchainWriteEnabled } from '../../config/cglt-blockchain-mode';
import { matchesAnySecret } from '../../security/secret-compare';
import { checkDestinationAddress } from '../../lib/address-guard';

const CGLT_PER_WCGLT = parseInt(process.env.CGLT_PER_WCGLT ?? '500');

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

/**
 * Shared-secret guard for CongoGaming → UniPay server-to-server calls.
 *
 * Trust boundary 1: accepts CONGOGAMING_API_KEY (new) or GAMING_API_KEY (legacy fallback).
 * Never accepts BRIDGE_INBOUND_API_KEY — that belongs to trust boundary 2.
 *
 * Uses constant-time comparison via matchesAnySecret().
 */
function requireGamingKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const newKey = env.CONGOGAMING_API_KEY;
  const legacyKey = env.GAMING_API_KEY;

  if (!newKey && !legacyKey) {
    reply.status(500).send({ error: 'Gaming integration not configured', statusCode: 500 });
    return false;
  }

  const provided = request.headers['x-api-key'];
  if (typeof provided !== 'string' || !matchesAnySecret(provided, [newKey, legacyKey])) {
    reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
    return false;
  }

  // Log if the legacy key was used (no secret value in log)
  if (newKey && legacyKey && !matchesAnySecret(provided, [newKey]) && matchesAnySecret(provided, [legacyKey])) {
    request.log.warn({ boundary: 'congogaming_to_unipay' }, '[LEGACY_API_KEY_USED]');
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

      const wallet = await findOrCreateWalletByPhone(fastify.supabase, phone, fastify.log);

      if (!wallet) {
        return reply.status(500).send({ error: 'WALLET_LOOKUP_FAILED', statusCode: 500 });
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

      const { data: debitedBalance, error: debitError } = await fastify.supabase
        .rpc('wallet_debit_cglt', { p_user_id: wallet.id, p_amount: amount });
      if (debitError) {
        const isInsufficient = debitError.message?.includes('INSUFFICIENT_CGLT');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'INSUFFICIENT_CGLT' : 'CGLT_DEBIT_FAILED',
          statusCode: isInsufficient ? 402 : 500,
        });
      }
      const newBalance = Number(debitedBalance);

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

      const wallet = await findOrCreateWalletByPhone(fastify.supabase, phone, fastify.log);

      if (!wallet) {
        return reply.status(500).send({ error: 'WALLET_LOOKUP_FAILED', statusCode: 500 });
      }
      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const { data: creditedBalance, error: creditError } = await fastify.supabase
        .rpc('wallet_credit_cglt', { p_user_id: wallet.id, p_amount: amount });
      if (creditError) {
        fastify.log.error({ err: creditError, walletId: wallet.id, amount }, '[gaming] CGLT credit failed');
        return reply.status(500).send({ error: 'CGLT_CREDIT_FAILED', statusCode: 500 });
      }
      const newBalance = Number(creditedBalance);

      // ── Mint CGLT on-chain (only if blockchain is enabled) ──
      let blockchainTxHash: string | null = null;
      if (wallet.blockchain_address && isCgltBlockchainWriteEnabled()) {
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

      fastify.log.info({ walletId: wallet.id, amount, game_ref, tx_ref, blockchainTxHash, settlement_mode: blockchainTxHash ? 'blockchain' : 'ledger' }, '[gaming] CGLT credit');

      return reply.status(201).send({
        success:            true,
        new_balance:        newBalance,
        blockchain_tx_hash: blockchainTxHash,
        settlement_mode:    blockchainTxHash ? 'blockchain' : 'ledger',
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

      const wallet = await findOrCreateWalletByPhone(fastify.supabase, phone, fastify.log);

      if (!wallet) {
        return reply.status(500).send({ error: 'WALLET_LOOKUP_FAILED', statusCode: 500 });
      }

      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      let equivalentUsdt: number | null = null;
      try {
        const { rate } = await getSwapRate();
        if (rate > 0) equivalentUsdt = cgltBalance / rate;
      } catch (err) {
        fastify.log.debug('[gaming] swap rate unavailable for equivalent_usdt — reserve not configured');
      }

      return {
        phone:           wallet.phone,
        cglt_balance:    cgltBalance,
        equivalent_usdt: equivalentUsdt,
      };
    },
  );

  /* ── POST /v1/wallet/cglt-withdraw-bsc — retrait CGLT → wCGLT BSC ── */
  fastify.post<{ Body: { phone: string; amount: number; bsc_address: string } }>(
    '/wallet/cglt-withdraw-bsc',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'amount', 'bsc_address'],
          properties: {
            phone:       { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            amount:      { type: 'number', minimum: 10 },
            bsc_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireGamingKey(request, reply)) return;

      const { phone, amount, bsc_address } = request.body;

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, is_active, cglt_balance')
        .eq('phone', phone)
        .maybeSingle();

      if (!wallet) return reply.status(404).send({ error: 'WALLET_NOT_FOUND' });
      if (!wallet.is_active) return reply.status(403).send({ error: 'ACCOUNT_SUSPENDED' });

      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      if (cgltBalance < amount) {
        return reply.status(402).send({ error: 'INSUFFICIENT_CGLT', available: cgltBalance });
      }

      // Conversion CGLT gaming → wCGLT BSC
      const wCGLTAmount = amount / CGLT_PER_WCGLT;
      if (wCGLTAmount < 0.001) {
        return reply.status(400).send({ error: 'AMOUNT_TOO_SMALL', min_cglt: CGLT_PER_WCGLT });
      }

      // blockchain_required — 503 avant toute modification DB
      if (!isCgltBlockchainWriteEnabled()) {
        return reply.status(503).send({ error: 'CGLT_BLOCKCHAIN_DISABLED', message: 'Bridge operations are disabled' });
      }

      // Débiter le wallet UniPay
      const operationId = crypto.randomUUID();
      const operationReference = `CGLT-BSC-${operationId.slice(0, 8).toUpperCase()}`;
      const { data: debitedBalance, error: debitError } = await fastify.supabase.rpc(
        'begin_wcglt_onchain_operation',
        {
          p_operation_id: operationId,
          p_user_id: wallet.id,
          p_amount_debited: amount,
          p_amount_onchain: wCGLTAmount,
          p_recipient: bsc_address,
          p_reference: operationReference,
          p_source: 'gaming_cglt_withdraw',
          p_operator: 'cglt',
          p_direction: 'cglt_bsc_withdraw',
          p_phone: wallet.phone,
          p_metadata: { wcglt_amount: wCGLTAmount, cglt_per_wcglt: CGLT_PER_WCGLT },
        },
      );
      if (debitError) {
        const isInsufficient = debitError.message?.includes('INSUFFICIENT_CGLT');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'INSUFFICIENT_CGLT' : 'CGLT_DEBIT_FAILED',
        });
      }
      const newBalance = Number(debitedBalance);

      let bscTxHash: string | null = null;
      try {
        bscTxHash = await mintWCGLT(bsc_address, amount, operationId);
      } catch (err) {
        if (err instanceof BridgeOutcomeUnknownError) {
          await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
            p_operation_id: operationId,
            p_tx_hash: null,
            p_reason: err.message,
          });
          fastify.log.warn({ err, operationId, phone }, '[cglt] BSC bridge outcome pending verification');
          return reply.status(202).send({
            success: false,
            status: 'pending_onchain_check',
            operation_id: operationId,
            new_balance: newBalance,
          });
        }
        await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
          p_operation_id: operationId,
          p_outcome: 'failed',
          p_tx_hash: null,
          p_reason: err instanceof Error ? err.message : 'BRIDGE_FAILED',
        });
        fastify.log.error({ err, phone, bsc_address, amount }, '[cglt] BSC bridge failed before broadcast (refunded)');
        return reply.status(502).send({ error: 'BRIDGE_FAILED' });
      }

      const { error: finalizeError } = await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
        p_operation_id: operationId,
        p_outcome: 'confirmed',
        p_tx_hash: bscTxHash,
        p_reason: null,
      });
      if (finalizeError) {
        await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
          p_operation_id: operationId,
          p_tx_hash: bscTxHash,
          p_reason: 'DATABASE_FINALIZATION_UNCERTAIN',
        });
        return reply.status(202).send({
          success: false,
          status: 'pending_onchain_check',
          operation_id: operationId,
          bsc_tx_hash: bscTxHash,
          new_balance: newBalance,
        });
      }

      return reply.status(201).send({
        success:      true,
        new_balance:  newBalance,
        bsc_tx_hash:  bscTxHash,
        bsc_address,
        wcglt_amount: wCGLTAmount,
      });
    },
  );

  /* ── POST /v1/wallet/user/cglt-withdraw-bsc — user-facing (JWT auth) ── */
  fastify.post<{ Body: { amount: number; bsc_address: string } }>(
    '/wallet/user/cglt-withdraw-bsc',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount', 'bsc_address'],
          properties: {
            amount:      { type: 'number', minimum: 500 },
            bsc_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          },
        },
      },
      config: {
        rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: walletIdFromRequest },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, phone, is_active, cglt_balance');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const { payload } = auth;
      const wallet = auth.wallet as { id: string; phone: string; is_active: boolean; cglt_balance: number };

      const { amount, bsc_address } = request.body;
      const phone = payload.phone;

      const cgltBalance = Number(wallet.cglt_balance ?? 0);
      if (cgltBalance < amount) {
        return reply.status(402).send({ error: 'INSUFFICIENT_CGLT', available: cgltBalance });
      }

      const wCGLTAmount = amount / CGLT_PER_WCGLT;
      if (wCGLTAmount < 0.001) {
        return reply.status(400).send({ error: 'AMOUNT_TOO_SMALL', min_cglt: CGLT_PER_WCGLT });
      }

      // blockchain_required — 503 avant toute modification DB
      if (!isCgltBlockchainWriteEnabled()) {
        return reply.status(503).send({ error: 'CGLT_BLOCKCHAIN_DISABLED', message: 'Bridge operations are disabled' });
      }

      /* ── Destination address guard (forbidden + contract detection) ── */
      const guard = await checkDestinationAddress(bsc_address, fastify.supabase);
      if (!guard.ok) {
        fastify.log.warn({ phone, bsc_address }, '[cglt-user] BSC withdraw blocked — address guard');
        return reply.status(guard.status).send(guard.body);
      }

      const operationId = crypto.randomUUID();
      const operationReference = `CGLT-BSC-${operationId.slice(0, 8).toUpperCase()}`;
      const { data: debitedBalance, error: debitError } = await fastify.supabase.rpc(
        'begin_wcglt_onchain_operation',
        {
          p_operation_id: operationId,
          p_user_id: wallet.id,
          p_amount_debited: amount,
          p_amount_onchain: wCGLTAmount,
          p_recipient: bsc_address,
          p_reference: operationReference,
          p_source: 'wallet_cglt_withdraw',
          p_operator: 'cglt',
          p_direction: 'cglt_bsc_withdraw',
          p_phone: wallet.phone,
          p_metadata: { wcglt_amount: wCGLTAmount, cglt_per_wcglt: CGLT_PER_WCGLT },
        },
      );
      if (debitError) {
        const isInsufficient = debitError.message?.includes('INSUFFICIENT_CGLT');
        return reply.status(isInsufficient ? 402 : 500).send({
          error: isInsufficient ? 'INSUFFICIENT_CGLT' : 'CGLT_DEBIT_FAILED',
        });
      }
      const newBalance = Number(debitedBalance);

      let bscTxHash: string | null = null;
      try {
        bscTxHash = await mintWCGLT(bsc_address, amount, operationId);
      } catch (err) {
        if (err instanceof BridgeOutcomeUnknownError) {
          await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
            p_operation_id: operationId,
            p_tx_hash: null,
            p_reason: err.message,
          });
          fastify.log.warn({ err, operationId, phone }, '[cglt-user] BSC bridge outcome pending verification');
          return reply.status(202).send({
            success: false,
            status: 'pending_onchain_check',
            operation_id: operationId,
            new_balance: newBalance,
          });
        }
        await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
          p_operation_id: operationId,
          p_outcome: 'failed',
          p_tx_hash: null,
          p_reason: err instanceof Error ? err.message : 'BRIDGE_FAILED',
        });
        fastify.log.error({ err, phone, bsc_address, amount }, '[cglt-user] BSC bridge failed before broadcast (refunded)');
        return reply.status(502).send({ error: 'BRIDGE_FAILED' });
      }

      const { error: finalizeError } = await fastify.supabase.rpc('resolve_wcglt_onchain_operation', {
        p_operation_id: operationId,
        p_outcome: 'confirmed',
        p_tx_hash: bscTxHash,
        p_reason: null,
      });
      if (finalizeError) {
        await fastify.supabase.rpc('mark_wcglt_operation_pending_check', {
          p_operation_id: operationId,
          p_tx_hash: bscTxHash,
          p_reason: 'DATABASE_FINALIZATION_UNCERTAIN',
        });
        return reply.status(202).send({
          success: false,
          status: 'pending_onchain_check',
          operation_id: operationId,
          bsc_tx_hash: bscTxHash,
          new_balance: newBalance,
        });
      }

      return reply.status(201).send({
        success:      true,
        new_balance:  newBalance,
        bsc_tx_hash:  bscTxHash,
        bsc_address,
        wcglt_amount: wCGLTAmount,
      });
    },
  );
};

export default cgltGamingRoute;

