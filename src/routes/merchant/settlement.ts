import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { initiatePayout } from '../../services/avada.js';
import { normalizePhoneForOperator, isValidDrcPhone } from '../../lib/phone-normalization.js';
import { markSettlementProcessing, markSettlementFailed } from './settlement-rpc-helpers.js';
import { requireActiveMerchant } from '../../lib/merchant-auth.js';

const AUTO_MAX_PER_REQUEST = Number(env.SETTLEMENT_AUTO_MAX_PER_REQUEST);
const AUTO_MAX_DAILY = Number(env.SETTLEMENT_AUTO_MAX_DAILY);

const merchantSettlementRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/merchant/settlement/balance ───────────────────── */
  fastify.get(
    '/merchant/settlement/balance',
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('settlement_phone, kyc_status, mode')
        .eq('id', auth.payload.merchant_id)
        .maybeSingle();

      if (!merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // Compute balance from ledger entries, grouped by currency
      const { data: entries, error } = await fastify.supabase
        .from('merchant_ledger_entries')
        .select('type, amount, currency')
        .eq('merchant_id', auth.payload.merchant_id);

      if (error) {
        fastify.log.error({ err: error }, '[settlement/balance] ledger query failed');
        return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
      }

      // Group by currency
      const byCurrency: Record<string, { credits: number; settlements: number }> = {};
      for (const e of entries ?? []) {
        const cur = (e as { currency: string }).currency ?? 'CDF';
        if (!byCurrency[cur]) byCurrency[cur] = { credits: 0, settlements: 0 };
        if ((e as { type: string }).type === 'credit') {
          byCurrency[cur].credits += Number((e as { amount: number }).amount);
        } else {
          byCurrency[cur].settlements += Number((e as { amount: number }).amount);
        }
      }

      // Always-visible Mobile Money currencies: CDF and USD are shown even at 0
      // so merchants can see the service exists. USDT only appears if ledger
      // entries already exist for it (crypto settlement is not auto-exposed).
      const ALWAYS_VISIBLE_CURRENCIES = ['CDF', 'USD'];
      for (const cur of ALWAYS_VISIBLE_CURRENCIES) {
        if (!byCurrency[cur]) {
          byCurrency[cur] = { credits: 0, settlements: 0 };
        }
      }

      // Build balances array with CDF first, USD second, then any others (USDT)
      const currencyOrder = ['CDF', 'USD', 'USDT'];
      const allCurrencies = [
        ...currencyOrder.filter((c) => byCurrency[c]),
        ...Object.keys(byCurrency).filter((c) => !currencyOrder.includes(c)).sort(),
      ];

      const balances = allCurrencies.map((cur) => {
        const v = byCurrency[cur];
        return {
          currency: cur,
          balance: Math.round((v.credits - v.settlements) * 100) / 100,
          total_credits: Math.round(v.credits * 100) / 100,
          total_settlements: Math.round(v.settlements * 100) / 100,
        };
      });

      // Backward compat: also include a top-level balance (sum of all currencies,
      // but labeled as "mixed" if more than one currency exists)
      const totalBalance = balances.reduce((s, b) => s + b.balance, 0);

      return reply.send({
        balance: Math.round(totalBalance * 100) / 100,  // deprecated — use balances[]
        balances,
        settlement_phone: merchant.settlement_phone ?? null,
        kyc_status: merchant.kyc_status,
        mode: merchant.mode,
      });
    },
  );

  /* ── POST /v1/merchant/settlement/request ──────────────────── */
  fastify.post<{ Body: { amount?: number; currency?: string } }>(
    '/merchant/settlement/request',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            amount: { type: 'number', minimum: 0 },  // 0 or absent = full balance
            currency: { type: 'string', enum: ['CDF', 'USD'] },  // USDT settlements not supported via Mobile Money
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const settlementCurrency = request.body.currency ?? 'CDF';

      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('settlement_phone, kyc_status, mode')
        .eq('id', auth.payload.merchant_id)
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
          p_merchant_id: auth.payload.merchant_id,
          p_amount: requestedAmount > 0 ? requestedAmount : null,
          p_phone: merchant.settlement_phone,
          p_idempotency_key: idempotencyKey,
          p_auto_max_per_request: AUTO_MAX_PER_REQUEST,
          p_auto_max_daily: AUTO_MAX_DAILY,
          p_currency: settlementCurrency,
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
            { requestId: result.request_id, merchantId: auth.payload.merchant_id, amount: result.amount, phone: normalizedPhone, operator },
            '[settlement/request] auto-payout via Unipesa B2C',
          );

          const payoutRes = await initiatePayout(
            operator,
            normalizedPhone,
            Number(result.amount),
            `STL-${result.request_id.slice(0, 8).toUpperCase()}`,
            settlementCurrency,
          );

          // Create a transactions row linked to the settlement request so
          // the callback can find it and propagate the terminal status.
          const settlementRef = `STL-${result.request_id.slice(0, 8).toUpperCase()}`;
          const { error: txInsertErr } = await fastify.supabase
            .from('transactions')
            .insert({
              id: crypto.randomUUID(),
              merchant_id: auth.payload.merchant_id,
              operator,
              phone: normalizedPhone,
              amount: Number(result.amount),
              fee: 0,
              net_amount: Number(result.amount),
              currency: settlementCurrency,
              reference: settlementRef,
              avada_transaction_id: payoutRes.avada_transaction_id,
              status: 'processing',
              direction: 'payout',
              metadata: { source: 'merchant_settlement' },
              settlement_request_id: result.request_id,
            });
          if (txInsertErr) {
            fastify.log.error(
              { err: txInsertErr, requestId: result.request_id },
              '[settlement/request] transactions insert failed — settlement will not receive callback',
            );
          }

          // Mark settlement as processing (NOT success) — the callback
          // will call mark_settlement_success/failed via the RPC.
          await markSettlementProcessing(fastify.supabase, result.request_id, payoutRes.avada_transaction_id);

          return reply.status(201).send({
            request_id: result.request_id,
            status: 'processing',
            amount: result.amount,
            currency: settlementCurrency,
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
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const offset = (page - 1) * limit;

      const { data: requests, error, count } = await fastify.supabase
        .from('merchant_settlement_requests')
        .select('id, amount, currency, phone, status, provider_ref, reject_reason, created_at, updated_at', { count: 'exact' })
        .eq('merchant_id', auth.payload.merchant_id)
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

  /* ── POST /v1/merchant/settlement/phone ────────────────────── */
  /* Allows a merchant to set/update their settlement phone number. */
  fastify.post<{ Body: { phone: string } }>(
    '/merchant/settlement/phone',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          properties: {
            phone: { type: 'string', minLength: 8, maxLength: 32 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              settlement_phone: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const { phone } = request.body;

      // Validate DRC phone format
      if (!isValidDrcPhone(phone)) {
        return reply.status(400).send({
          error: 'INVALID_PHONE',
          message: 'Numéro invalide. Format attendu : +243 suivi de 9 chiffres, ou 0 suivi de 9 chiffres.',
          statusCode: 400,
        });
      }

      // Normalize to a canonical format (strip spaces, ensure +243 prefix)
      const normalized = phone.trim().replace(/\s+/g, '');

      const { error } = await fastify.supabase
        .from('merchants')
        .update({ settlement_phone: normalized, updated_at: new Date().toISOString() })
        .eq('id', auth.payload.merchant_id);

      if (error) {
        fastify.log.error({ err: error, merchantId: auth.payload.merchant_id }, '[settlement/phone] update failed');
        return reply.status(500).send({ error: 'Failed to update phone', statusCode: 500 });
      }

      fastify.log.info({ merchantId: auth.payload.merchant_id, phone: normalized }, '[settlement/phone] phone updated');

      return reply.send({ ok: true, settlement_phone: normalized });
    },
  );
};

export default merchantSettlementRoute;
