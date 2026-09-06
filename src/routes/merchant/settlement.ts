import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { verifyToken, type JwtPayload } from '../../utils/jwt.js';
import { initiatePayout } from '../../services/avada.js';
import { normalizePhoneForOperator, isValidDrcPhone } from '../../lib/phone-normalization.js';
import { markSettlementSuccess, markSettlementFailed } from './settlement-rpc-helpers.js';

function requireMerchantAuth(request: { headers: Record<string, string | string[] | undefined> }): JwtPayload | null {
  if (!env.JWT_SECRET) return null;
  const auth = request.headers.authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7), env.JWT_SECRET);
}

const AUTO_MAX_PER_REQUEST = Number(env.SETTLEMENT_AUTO_MAX_PER_REQUEST);
const AUTO_MAX_DAILY = Number(env.SETTLEMENT_AUTO_MAX_DAILY);

const merchantSettlementRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/merchant/settlement/balance ───────────────────── */
  fastify.get(
    '/merchant/settlement/balance',
    async (request, reply) => {
      const payload = requireMerchantAuth(request);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('settlement_phone, kyc_status, mode')
        .eq('id', payload.merchant_id)
        .maybeSingle();

      if (!merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // Compute balance from ledger entries
      const { data: entries, error } = await fastify.supabase
        .from('merchant_ledger_entries')
        .select('type, amount')
        .eq('merchant_id', payload.merchant_id);

      if (error) {
        fastify.log.error({ err: error }, '[settlement/balance] ledger query failed');
        return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
      }

      const credits = (entries ?? [])
        .filter((e: { type: string }) => e.type === 'credit')
        .reduce((s: number, e: { amount: number }) => s + Number(e.amount), 0);
      const settlements = (entries ?? [])
        .filter((e: { type: string }) => e.type === 'settlement')
        .reduce((s: number, e: { amount: number }) => s + Number(e.amount), 0);

      return reply.send({
        balance: Math.round((credits - settlements) * 100) / 100,
        total_credits: Math.round(credits * 100) / 100,
        total_settlements: Math.round(settlements * 100) / 100,
        settlement_phone: merchant.settlement_phone ?? null,
        kyc_status: merchant.kyc_status,
        mode: merchant.mode,
      });
    },
  );

  /* ── POST /v1/merchant/settlement/request ──────────────────── */
  fastify.post<{ Body: { amount?: number } }>(
    '/merchant/settlement/request',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            amount: { type: 'number', minimum: 0 },  // 0 or absent = full balance
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const payload = requireMerchantAuth(request);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('settlement_phone, kyc_status, mode')
        .eq('id', payload.merchant_id)
        .maybeSingle();

      if (!merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // KYC + mode checks
      if (merchant.kyc_status !== 'approved') {
        return reply.status(403).send({
          error: 'KYC_REQUIRED',
          message: 'Votre KYC doit être approuvé pour demander un règlement.',
          statusCode: 403,
        });
      }

      if (merchant.mode !== 'live') {
        return reply.status(403).send({
          error: 'LIVE_MODE_REQUIRED',
          message: 'Votre compte doit être en mode live pour demander un règlement.',
          statusCode: 403,
        });
      }

      // Settlement phone required
      if (!merchant.settlement_phone) {
        return reply.status(400).send({
          error: 'SETTLEMENT_PHONE_REQUIRED',
          message: 'Aucun numéro de règlement configuré. Veuillez contacter l\'administrateur pour définir votre numéro Mobile Money de règlement.',
          statusCode: 400,
        });
      }

      // Validate phone format
      if (!isValidDrcPhone(merchant.settlement_phone)) {
        return reply.status(400).send({
          error: 'INVALID_SETTLEMENT_PHONE',
          message: 'Le numéro de règlement configuré est invalide (9 chiffres significatifs requis).',
          statusCode: 400,
        });
      }

      const requestedAmount = request.body.amount ?? 0;
      const idempotencyKey = crypto.randomUUID();

      // Call the atomic RPC
      const { data: rpcResult, error: rpcError } = await fastify.supabase.rpc(
        'process_merchant_settlement',
        {
          p_merchant_id: payload.merchant_id,
          p_amount: requestedAmount > 0 ? requestedAmount : null,
          p_phone: merchant.settlement_phone,
          p_idempotency_key: idempotencyKey,
          p_auto_max_per_request: AUTO_MAX_PER_REQUEST,
          p_auto_max_daily: AUTO_MAX_DAILY,
        },
      );

      if (rpcError) {
        const msg = rpcError.message ?? '';
        if (msg.includes('INSUFFICIENT_BALANCE')) {
          return reply.status(402).send({
            error: 'INSUFFICIENT_BALANCE',
            message: 'Solde insuffisant pour ce règlement.',
            statusCode: 402,
          });
        }
        fastify.log.error({ err: rpcError }, '[settlement/request] RPC failed');
        return reply.status(500).send({ error: 'Settlement processing failed', statusCode: 500 });
      }

      const result = rpcResult as {
        idempotent?: boolean;
        request_id?: string;
        amount?: number;
        status?: string;
        auto_payout?: boolean;
        ledger_entry_id?: string;
        balance_after?: number;
      };

      // If idempotent (shouldn't happen with UUID key, but handle it)
      if (result.idempotent) {
        return reply.status(200).send({
          idempotent: true,
          request_id: result.request_id,
        });
      }

      // If auto-payout, trigger B2C via Unipesa
      if (result.auto_payout && result.request_id) {
        try {
          // Determine operator from phone prefix (simplified — could be enhanced)
          // For now, use 'orange' as default; the admin can set the operator
          // on the merchant's settlement_phone or we detect from prefix.
          // TODO: store settlement_operator on merchant
          const operator = 'orange'; // default — will be configurable
          const normalizedPhone = normalizePhoneForOperator(merchant.settlement_phone, operator);

          fastify.log.info(
            { requestId: result.request_id, merchantId: payload.merchant_id, amount: result.amount, phone: normalizedPhone, operator },
            '[settlement/request] auto-payout via Unipesa B2C',
          );

          const payoutRes = await initiatePayout(
            operator,
            normalizedPhone,
            Number(result.amount),
            `STL-${result.request_id.slice(0, 8).toUpperCase()}`,
            'CDF',
          );

          // Mark settlement as success
          await markSettlementSuccess(fastify.supabase, result.request_id, payoutRes.avada_transaction_id);

          return reply.status(201).send({
            request_id: result.request_id,
            status: 'success',
            amount: result.amount,
            provider_ref: payoutRes.avada_transaction_id,
            balance_after: result.balance_after,
            auto_payout: true,
          });
        } catch (err: any) {
          fastify.log.error(
            { err: err?.message, requestId: result.request_id },
            '[settlement/request] auto-payout failed — marking settlement as failed',
          );
          await markSettlementFailed(fastify.supabase, result.request_id, `Payout failed: ${err?.message ?? 'unknown'}`);
          return reply.status(502).send({
            error: 'PAYOUT_FAILED',
            message: 'Le règlement a échoué côté provider. Le solde a été recrédité.',
            request_id: result.request_id,
            statusCode: 502,
          });
        }
      }

      // Admin review needed
      return reply.status(201).send({
        request_id: result.request_id,
        status: 'pending_admin_review',
        amount: result.amount,
        balance_after: result.balance_after,
        auto_payout: false,
        message: 'Votre demande de règlement nécessite une revue administrateur. Vous serez notifié une fois traitée.',
      });
    },
  );

  /* ── GET /v1/merchant/settlement/history ───────────────────── */
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/merchant/settlement/history',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const payload = requireMerchantAuth(request);
      if (!payload) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const offset = (page - 1) * limit;

      const { data: requests, error, count } = await fastify.supabase
        .from('merchant_settlement_requests')
        .select('id, amount, phone, status, provider_ref, reject_reason, created_at, updated_at', { count: 'exact' })
        .eq('merchant_id', payload.merchant_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        fastify.log.error({ err: error }, '[settlement/history] query failed');
        return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
      }

      return reply.send({
        requests: requests ?? [],
        total: count ?? 0,
        page,
        limit,
      });
    },
  );
};

export default merchantSettlementRoute;
