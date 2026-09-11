import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sendAdminDirectEmail } from '../../services/email.js';
import { env } from '../../config/env.js';
import { logAdminAction } from '../../lib/admin-action-log.js';
import { buildEmailTemplates, type MerchantTemplateData } from '../../lib/email-templates.js';
import { sendTemplateAuto } from '../../lib/email-auto-send.js';
import { initiatePayout } from '../../services/avada.js';
import { normalizePhoneForOperator, isValidDrcPhone } from '../../lib/phone-normalization.js';
import { markSettlementSuccess, markSettlementFailed } from '../merchant/settlement-rpc-helpers.js';
import { isProviderOutageFailure } from '../../lib/provider-outage.js';

function requireAdmin(isAdmin: boolean): boolean {
  return isAdmin;
}

interface MerchantTransactionsQuery {
  page: number;
  limit: number;
  merchant_id?: string;
  status?: string;
  operator?: string;
  direction?: string;
  mode?: string;
  date_from?: string;
  date_to?: string;
}

interface MerchantListQuery {
  page?: number;
  limit?: number;
  mode?: string;
  kyc_status?: string;
  status?: string;
  search?: string;
}

const adminMerchantsRoute: FastifyPluginAsync = async (fastify) => {
  /* ── GET /v1/admin/merchants/stats ─────────────────────────── */
  fastify.get('/admin/merchants/stats', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const [
      totalRes,
      sandboxRes,
      liveRes,
      kycPendingRes,
      kycSubmittedRes,
      kycApprovedRes,
      volume30dRes,
      todayCountRes,
    ] = await Promise.all([
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }),
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('mode', 'sandbox'),
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('mode', 'live'),
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('kyc_status', 'pending'),
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('kyc_status', 'submitted'),
      fastify.supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('kyc_status', 'approved'),
      fastify.supabase
        .from('transactions')
        .select('net_amount, currency')
        .not('merchant_id', 'is', null)
        .eq('status', 'success')
        .gte('created_at', thirtyDaysAgo),
      fastify.supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .not('merchant_id', 'is', null)
        .gte('created_at', todayStart),
    ]);

    // Aggregate volume by currency
    const volumeByCurrency: Record<string, number> = {};
    for (const tx of volume30dRes.data ?? []) {
      const cur = (tx as { currency?: string }).currency ?? 'CDF';
      const net = Number((tx as { net_amount?: string | number }).net_amount ?? 0);
      volumeByCurrency[cur] = (volumeByCurrency[cur] ?? 0) + net;
    }

    return reply.send({
      total_merchants: totalRes.count ?? 0,
      mode_breakdown: {
        sandbox: sandboxRes.count ?? 0,
        live: liveRes.count ?? 0,
      },
      kyc_breakdown: {
        pending: kycPendingRes.count ?? 0,
        submitted: kycSubmittedRes.count ?? 0,
        approved: kycApprovedRes.count ?? 0,
      },
      volume_30d: volumeByCurrency,
      transactions_today: todayCountRes.count ?? 0,
    });
  });

  /* ── GET /v1/admin/merchants (liste enrichie) ──────────────── */
  fastify.get<{ Querystring: MerchantListQuery }>(
    '/admin/merchants',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            mode:       { type: 'string', enum: ['sandbox', 'live'] },
            kyc_status: { type: 'string', enum: ['pending', 'submitted', 'approved', 'rejected'] },
            status:     { type: 'string', enum: ['active', 'suspended', 'pending'] },
            search:     { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 50;
      const offset = (page - 1) * limit;

      let q = fastify.supabase
        .from('merchants')
        .select(
          'id, name, email, phone, country, mode, kyc_status, status, company_name, company_rccm, company_idnat, kyc_submitted_at, kyc_notes, kyc_reviewed_at, created_at, updated_at, rccm_file_url, idnat_file_url, rep_id_file_url',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false });

      if (request.query.mode) q = q.eq('mode', request.query.mode);
      if (request.query.kyc_status) q = q.eq('kyc_status', request.query.kyc_status);
      if (request.query.status) q = q.eq('status', request.query.status);
      if (request.query.search) {
        const s = request.query.search.trim();
        q = q.or(`name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%`);
      }

      q = q.range(offset, offset + limit - 1);

      const { data: merchants, error, count } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      // Enrich with transaction stats + API key status + KYC reminder counts
      const merchantIds = (merchants ?? []).map((m) => (m as { id: string }).id);
      let txStatsMap: Record<string, { tx_count: number; total_volume: number; last_tx_at: string | null }> = {};
      let keyStatusMap: Record<string, { has_active_key: boolean; key_count: number }> = {};
      let kycReminderMap: Record<string, { count: number; last_sent_at: string | null }> = {};

      if (merchantIds.length > 0) {
        const [txStatsRes, keyStatsRes, convsRes] = await Promise.all([
          fastify.supabase
            .from('transactions')
            .select('merchant_id, net_amount, created_at')
            .in('merchant_id', merchantIds)
            .eq('status', 'success'),
          fastify.supabase
            .from('api_keys')
            .select('merchant_id, is_active')
            .in('merchant_id', merchantIds),
          // Fetch conversations for these merchants to map conv_id → merchant_id
          fastify.supabase
            .from('support_conversations')
            .select('id, merchant_id')
            .in('merchant_id', merchantIds),
        ]);

        // Build conversation→merchant map
        const convToMerchant = new Map<string, string>();
        for (const c of convsRes.data ?? []) {
          convToMerchant.set((c as { id: string }).id, (c as { merchant_id: string }).merchant_id);
        }

        // Fetch email messages with template_label for these conversations
        const convIds = Array.from(convToMerchant.keys());
        if (convIds.length > 0) {
          const { data: emailMsgs } = await fastify.supabase
            .from('support_messages')
            .select('conversation_id, template_label, created_at')
            .eq('channel', 'email')
            .not('template_label', 'is', null)
            .in('conversation_id', convIds)
            .order('created_at', { ascending: false });

          // Count KYC reminder emails per merchant
          for (const msg of emailMsgs ?? []) {
            const label = (msg as { template_label: string }).template_label;
            // Match "Relance KYC" and similar KYC reminder templates
            if (/kyc/i.test(label)) {
              const mid = convToMerchant.get((msg as { conversation_id: string }).conversation_id);
              if (!mid) continue;
              if (!kycReminderMap[mid]) kycReminderMap[mid] = { count: 0, last_sent_at: null };
              kycReminderMap[mid].count += 1;
              const createdAt = (msg as { created_at: string }).created_at;
              if (!kycReminderMap[mid].last_sent_at || createdAt > kycReminderMap[mid].last_sent_at!) {
                kycReminderMap[mid].last_sent_at = createdAt;
              }
            }
          }
        }

        for (const tx of txStatsRes.data ?? []) {
          const mid = (tx as { merchant_id: string }).merchant_id;
          if (!txStatsMap[mid]) txStatsMap[mid] = { tx_count: 0, total_volume: 0, last_tx_at: null };
          txStatsMap[mid].tx_count++;
          txStatsMap[mid].total_volume += Number((tx as { net_amount: string | number }).net_amount ?? 0);
          const createdAt = (tx as { created_at: string }).created_at;
          if (!txStatsMap[mid].last_tx_at || createdAt > txStatsMap[mid].last_tx_at) {
            txStatsMap[mid].last_tx_at = createdAt;
          }
        }

        for (const k of keyStatsRes.data ?? []) {
          const mid = (k as { merchant_id: string }).merchant_id;
          if (!keyStatusMap[mid]) keyStatusMap[mid] = { has_active_key: false, key_count: 0 };
          keyStatusMap[mid].key_count++;
          if ((k as { is_active: boolean }).is_active) keyStatusMap[mid].has_active_key = true;
        }
      }

      const enriched = (merchants ?? []).map((m) => {
        const mid = (m as { id: string }).id;
        const stats = txStatsMap[mid] ?? { tx_count: 0, total_volume: 0, last_tx_at: null };
        const keys = keyStatusMap[mid] ?? { has_active_key: false, key_count: 0 };
        const kycReminder = kycReminderMap[mid] ?? { count: 0, last_sent_at: null };
        const row = m as { rccm_file_url?: string | null; idnat_file_url?: string | null; rep_id_file_url?: string | null };
        const kyc_docs_count =
          [row.rccm_file_url, row.idnat_file_url, row.rep_id_file_url].filter(Boolean).length;
        return {
          ...m,
          transaction_count: stats.tx_count,
          total_volume: stats.total_volume,
          last_transaction_at: stats.last_tx_at,
          api_key_status: keys.key_count === 0 ? 'none' : keys.has_active_key ? 'active' : 'inactive',
          last_kyc_reminder_count: kycReminder.count,
          last_kyc_reminder_at: kycReminder.last_sent_at,
          kyc_docs_count,
        };
      });

      return reply.send({
        data: enriched,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / limit),
        },
      });
    },
  );

  /* ── GET /v1/admin/merchants/:id (détail) ──────────────────── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/merchants/:id',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const [merchantRes, keysRes, txRes, ledgerRes, settlementRes] = await Promise.all([
        fastify.supabase
          .from('merchants')
          .select('id, name, email, phone, country, mode, kyc_status, status, company_name, company_rccm, company_idnat, kyc_submitted_at, kyc_notes, kyc_reviewed_at, created_at, updated_at, settlement_phone, webhook_url, webhook_secret, rccm_file_url, idnat_file_url, rep_id_file_url')
          .eq('id', id)
          .maybeSingle(),
        fastify.supabase
          .from('api_keys')
          .select('id, key_prefix, label, is_active, last_used_at, created_at')
          .eq('merchant_id', id)
          .order('created_at', { ascending: false }),
        fastify.supabase
          .from('transactions')
          .select('id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at')
          .eq('merchant_id', id)
          .order('created_at', { ascending: false })
          .limit(20),
        // Ledger entries for balance computation (same logic as
        // GET /merchant/settlement/balance but admin-side, no auth)
        fastify.supabase
          .from('merchant_ledger_entries')
          .select('type, amount, currency')
          .eq('merchant_id', id),
        // Settlement requests history (most recent 20)
        fastify.supabase
          .from('merchant_settlement_requests')
          .select('id, amount, currency, phone, status, provider_ref, reject_reason, created_at, updated_at')
          .eq('merchant_id', id)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      if (merchantRes.error) return reply.status(500).send({ error: merchantRes.error.message });
      if (!merchantRes.data) return reply.status(404).send({ error: 'Merchant not found' });

      // Compute per-currency balance from ledger entries
      // (mirrors GET /merchant/settlement/balance logic)
      const byCurrency: Record<string, { credits: number; settlements: number }> = {};
      for (const e of ledgerRes.data ?? []) {
        const cur = (e as { currency: string }).currency ?? 'CDF';
        if (!byCurrency[cur]) byCurrency[cur] = { credits: 0, settlements: 0 };
        if ((e as { type: string }).type === 'credit') {
          byCurrency[cur].credits += Number((e as { amount: number }).amount);
        } else {
          byCurrency[cur].settlements += Number((e as { amount: number }).amount);
        }
      }

      // Always show CDF and USD even at 0
      for (const cur of ['CDF', 'USD']) {
        if (!byCurrency[cur]) byCurrency[cur] = { credits: 0, settlements: 0 };
      }

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

      // Generate signed URLs (30-day expiry) for any uploaded KYC documents
      // so the admin can view/download them. Mirrors the dev-expenses report
      // signed-URL pattern.
      const merchantData = merchantRes.data as
        | (Record<string, unknown> & { rccm_file_url?: string | null; idnat_file_url?: string | null; rep_id_file_url?: string | null })
        | null;

      const signDoc = async (path: string | null | undefined): Promise<string | null> => {
        if (!path) return null;
        const { data: signed, error: sErr } = await fastify.supabase.storage
          .from('merchant-kyc-docs')
          .createSignedUrl(path, 30 * 24 * 60 * 60);
        if (sErr || !signed?.signedUrl) {
          fastify.log.warn({ err: sErr, path }, '[admin/merchants/:id] signed URL failed for KYC doc');
          return null;
        }
        return signed.signedUrl;
      };

      const [rccmSigned, idnatSigned, repIdSigned] = await Promise.all([
        signDoc(merchantData?.rccm_file_url),
        signDoc(merchantData?.idnat_file_url),
        signDoc(merchantData?.rep_id_file_url),
      ]);

      const merchantWithDocs = merchantData
        ? {
            ...merchantData,
            rccm_file_signed_url:   rccmSigned,
            idnat_file_signed_url:  idnatSigned,
            rep_id_file_signed_url: repIdSigned,
          }
        : merchantData;

      return reply.send({
        merchant: merchantWithDocs,
        api_keys: keysRes.data ?? [],
        transactions: txRes.data ?? [],
        balances,
        settlement_requests: settlementRes.data ?? [],
      });
    },
  );

  /* ── GET /v1/admin/merchants/:id/kyc-docs ────────────────────
     Returns signed URLs (30-day expiry) for the merchant's uploaded
     KYC documents. Called on demand by the admin KYC list modal so
     we don't generate signed URLs for every merchant in the list.
  ─────────────────────────────────────────────────────────────── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/merchants/:id/kyc-docs',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, kyc_status, rccm_file_url, idnat_file_url, rep_id_file_url')
        .eq('id', id)
        .maybeSingle();

      if (error || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      const signDoc = async (path: string | null | undefined): Promise<string | null> => {
        if (!path) return null;
        const { data: signed, error: sErr } = await fastify.supabase.storage
          .from('merchant-kyc-docs')
          .createSignedUrl(path, 30 * 24 * 60 * 60);
        if (sErr || !signed?.signedUrl) {
          fastify.log.warn({ err: sErr, path, id }, '[admin/merchants/:id/kyc-docs] signed URL failed');
          return null;
        }
        return signed.signedUrl;
      };

      const [rccmSigned, idnatSigned, repIdSigned] = await Promise.all([
        signDoc(merchant.rccm_file_url),
        signDoc(merchant.idnat_file_url),
        signDoc(merchant.rep_id_file_url),
      ]);

      return reply.send({
        merchant_id: id,
        kyc_status: merchant.kyc_status,
        docs: {
          rccm_file:   { path: merchant.rccm_file_url   ?? null, signed_url: rccmSigned },
          idnat_file:  { path: merchant.idnat_file_url  ?? null, signed_url: idnatSigned },
          rep_id_file: { path: merchant.rep_id_file_url ?? null, signed_url: repIdSigned },
        },
      });
    },
  );

  /* ── POST /v1/admin/merchants/:id/settle ────────────────────── */
  /* Admin-triggered manual settlement. Reuses the same process_merchant_settlement
   * RPC + initiatePayout flow as the merchant-side /merchant/settlement/request
   * endpoint, with the same thresholds and validations. */
  fastify.post<{ Params: { id: string }; Body: { amount?: number; currency?: string; phone?: string; operator?: string } }>(
    '/admin/merchants/:id/settle',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            amount:   { type: 'number', minimum: 0 },
            currency: { type: 'string', enum: ['CDF', 'USD'] },
            phone:    { type: 'string', minLength: 8, maxLength: 32 },
            operator: { type: 'string', enum: ['orange', 'airtel', 'afrimoney'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const settlementCurrency = request.body.currency ?? 'CDF';
      const operator = (request.body.operator ?? 'orange') as 'orange' | 'airtel' | 'afrimoney';
      const AUTO_MAX_PER_REQUEST = Number(env.SETTLEMENT_AUTO_MAX_PER_REQUEST);
      const AUTO_MAX_DAILY = Number(env.SETTLEMENT_AUTO_MAX_DAILY);

      // Fetch merchant
      const { data: merchant, error: mError } = await fastify.supabase
        .from('merchants')
        .select('id, settlement_phone, kyc_status, mode')
        .eq('id', id)
        .maybeSingle();

      if (mError) return reply.status(500).send({ error: mError.message });
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });

      // Same validations as merchant-side flow
      if (merchant.kyc_status !== 'approved') {
        return reply.status(403).send({ error: 'KYC_REQUIRED', message: 'Le KYC du marchand doit être approuvé.', statusCode: 403 });
      }
      if (merchant.mode !== 'live') {
        return reply.status(403).send({ error: 'LIVE_MODE_REQUIRED', message: 'Le marchand doit être en mode live.', statusCode: 403 });
      }

      // Use admin-provided phone or fall back to merchant's settlement_phone
      const phone = request.body.phone ?? merchant.settlement_phone;
      if (!phone) {
        return reply.status(400).send({ error: 'SETTLEMENT_PHONE_REQUIRED', message: 'Aucun numéro de règlement configuré.', statusCode: 400 });
      }
      if (!isValidDrcPhone(phone)) {
        return reply.status(400).send({ error: 'INVALID_SETTLEMENT_PHONE', message: 'Le numéro de règlement est invalide.', statusCode: 400 });
      }

      const requestedAmount = request.body.amount ?? 0;
      const idempotencyKey = crypto.randomUUID();

      // Call the same atomic RPC as the merchant flow
      const { data: rpcResult, error: rpcError } = await fastify.supabase.rpc(
        'process_merchant_settlement',
        {
          p_merchant_id: id,
          p_amount: requestedAmount > 0 ? requestedAmount : null,
          p_phone: phone,
          p_idempotency_key: idempotencyKey,
          p_auto_max_per_request: AUTO_MAX_PER_REQUEST,
          p_auto_max_daily: AUTO_MAX_DAILY,
          p_currency: settlementCurrency,
        },
      );

      if (rpcError) {
        const msg = rpcError.message ?? '';
        if (msg.includes('INSUFFICIENT_BALANCE')) {
          return reply.status(402).send({ error: 'INSUFFICIENT_BALANCE', message: 'Solde insuffisant pour ce règlement.', statusCode: 402 });
        }
        fastify.log.error({ err: rpcError }, '[admin/merchants/:id/settle] RPC failed');
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

      if (result.idempotent) {
        return reply.send({ idempotent: true, request_id: result.request_id });
      }

      // If auto-payout threshold met, trigger B2C via same path as merchant flow
      if (result.auto_payout && result.request_id) {
        try {
          const normalizedPhone = normalizePhoneForOperator(phone, operator);
          fastify.log.info(
            { requestId: result.request_id, merchantId: id, amount: result.amount, phone: normalizedPhone, operator },
            '[admin/merchants/:id/settle] auto-payout via Unipesa B2C',
          );

          const payoutRes = await initiatePayout(
            operator,
            normalizedPhone,
            Number(result.amount),
            `STL-${result.request_id.slice(0, 8).toUpperCase()}`,
            settlementCurrency,
          );

          await markSettlementSuccess(fastify.supabase, result.request_id, payoutRes.avada_transaction_id);
          void logAdminAction(fastify.supabase, 'merchant.settle', 'merchant', id, { request_id: result.request_id, amount: result.amount, currency: settlementCurrency, operator, auto_payout: true }, fastify.log);

          return reply.send({
            request_id: result.request_id,
            status: 'success',
            amount: result.amount,
            currency: settlementCurrency,
            provider_ref: payoutRes.avada_transaction_id,
            balance_after: result.balance_after,
            auto_payout: true,
          });
        } catch (err: any) {
          fastify.log.error({ err: err?.message, requestId: result.request_id }, '[admin/merchants/:id/settle] auto-payout failed');
          await markSettlementFailed(fastify.supabase, result.request_id, `Payout failed: ${err?.message ?? 'unknown'}`);
          return reply.status(502).send({
            error: 'PAYOUT_FAILED',
            message: 'Le payout a échoué. Le solde a été recrédité au marchand.',
            request_id: result.request_id,
            statusCode: 502,
          });
        }
      }

      // pending_admin_review — admin can approve via /admin/settlements/:id/approve
      void logAdminAction(fastify.supabase, 'merchant.settle', 'merchant', id, { request_id: result.request_id, amount: result.amount, currency: settlementCurrency, auto_payout: false }, fastify.log);

      return reply.send({
        request_id: result.request_id,
        status: 'pending_admin_review',
        amount: result.amount,
        currency: settlementCurrency,
        balance_after: result.balance_after,
        auto_payout: false,
      });
    },
  );

  /* ── GET /v1/admin/merchants/:id/stats ──────────────────────── */
  /* Per-merchant success/failure stats with operator breakdown and
   * provider-outage vs client-error classification. Reuses the same
   * isProviderOutageFailure logic as /status/operators. */
  fastify.get<{ Params: { id: string }; Querystring: { window?: '7d' | '30d' } }>(
    '/admin/merchants/:id/stats',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            window: { type: 'string', enum: ['7d', '30d'], default: '7d' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const { id } = request.params;
      const windowDays = request.query.window === '30d' ? 30 : 7;
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await fastify.supabase
        .from('transactions')
        .select('operator, status, created_at, metadata')
        .eq('merchant_id', id)
        .in('operator', ['airtel', 'orange', 'afrimoney'])
        .in('status', ['success', 'failed', 'processing'])
        .gte('created_at', since);

      if (error) {
        fastify.log.error({ err: error }, '[admin/merchants/:id/stats] query failed');
        return reply.status(500).send({ error: 'Internal server error', statusCode: 500 });
      }

      const rows = (data as Array<{ operator: string; status: string; created_at: string; metadata: Record<string, unknown> | null }>) ?? [];

      // Aggregate per-operator
      const byOperator: Record<string, {
        total: number; success: number; failed: number; processing: number;
        provider_outage: number; client_error: number;
      }> = {};

      for (const op of ['airtel', 'orange', 'afrimoney']) {
        byOperator[op] = { total: 0, success: 0, failed: 0, processing: 0, provider_outage: 0, client_error: 0 };
      }

      for (const row of rows) {
        const op = byOperator[row.operator];
        if (!op) continue;
        if (row.status === 'success') {
          op.success++;
        } else if (row.status === 'failed') {
          op.failed++;
          if (isProviderOutageFailure(row.metadata)) {
            op.provider_outage++;
          } else {
            op.client_error++;
          }
        } else if (row.status === 'processing') {
          op.processing++;
        }
      }

      // Build response with per-operator + totals
      const operators = ['airtel', 'orange', 'afrimoney'].map((op) => {
        const v = byOperator[op];
        const total = v.success + v.failed;
        return {
          operator: op,
          total_attempts: total,
          success_count: v.success,
          failed_count: v.failed,
          processing_count: v.processing,
          provider_outage_failures: v.provider_outage,
          client_error_failures: v.client_error,
          success_rate_pct: total > 0 ? Math.round((v.success / total) * 1000) / 10 : null,
        };
      });

      const totals = operators.reduce((acc, o) => ({
        total_attempts: acc.total_attempts + o.total_attempts,
        success_count: acc.success_count + o.success_count,
        failed_count: acc.failed_count + o.failed_count,
        processing_count: acc.processing_count + o.processing_count,
        provider_outage_failures: acc.provider_outage_failures + o.provider_outage_failures,
        client_error_failures: acc.client_error_failures + o.client_error_failures,
      }), { total_attempts: 0, success_count: 0, failed_count: 0, processing_count: 0, provider_outage_failures: 0, client_error_failures: 0 });

      const totalSuccessRate = totals.total_attempts > 0
        ? Math.round((totals.success_count / totals.total_attempts) * 1000) / 10
        : null;

      return reply.send({
        window: request.query.window ?? '7d',
        window_days: windowDays,
        totals: { ...totals, success_rate_pct: totalSuccessRate },
        operators,
      });
    },
  );

  /* ── PUT /v1/admin/merchants/:id/webhook-url ──────────────── */
  /* Update the merchant's webhook URL (the endpoint UniPay calls to
   * notify the merchant of transaction status changes). Uses the
   * existing merchants.webhook_url column — the same column the
   * merchant self-service endpoint (POST /v1/merchant/webhook) writes.
   * Does NOT regenerate webhook_secret (use the merchant self-service
   * endpoint for that). */
  fastify.put<{ Params: { id: string }; Body: { webhook_url: string | null } }>(
    '/admin/merchants/:id/webhook-url',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['webhook_url'],
          properties: {
            webhook_url: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }
      const { id } = request.params;
      const { webhook_url } = request.body;

      // Validate URL if not null/empty
      if (webhook_url) {
        try {
          const u = new URL(webhook_url);
          if (u.protocol !== 'https:') {
            return reply.status(400).send({ error: 'Webhook URL must use HTTPS', statusCode: 400 });
          }
        } catch {
          return reply.status(400).send({ error: 'Invalid webhook URL', statusCode: 400 });
        }
      }

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({ webhook_url: webhook_url || null })
        .eq('id', id)
        .select('id, webhook_url')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      void logAdminAction(fastify.supabase, 'merchant.webhook_url_update', 'merchant', id, { webhook_url }, fastify.log);

      return reply.send({ ok: true, webhook_url: data.webhook_url });
    },
  );

  /* ── PUT /v1/admin/merchants/:id/company-ids ──────────────── */
  /* Admin-only manual edit of a merchant's RCCM and ID Nat.
   * Used when a merchant sends their registration documents by email
   * instead of submitting them through the KYC form. Admin-only — the
   * merchant self-service PATCH /merchant/profile does NOT expose these
   * fields, so they cannot be set from the public merchant API. */
  fastify.put<{ Params: { id: string }; Body: { company_rccm?: string | null; company_idnat?: string | null } }>(
    '/admin/merchants/:id/company-ids',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            company_rccm:  { type: ['string', 'null'], maxLength: 128 },
            company_idnat: { type: ['string', 'null'], maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }
      const { id } = request.params;
      const { company_rccm, company_idnat } = request.body;

      const updates: Record<string, string | null> = {};
      if (company_rccm !== undefined) updates.company_rccm = company_rccm ? company_rccm.trim() || null : null;
      if (company_idnat !== undefined) updates.company_idnat = company_idnat ? company_idnat.trim() || null : null;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: 'No fields to update', statusCode: 400 });
      }

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update(updates)
        .eq('id', id)
        .select('id, company_rccm, company_idnat')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      void logAdminAction(fastify.supabase, 'merchant.company_ids_update', 'merchant', id, updates, fastify.log);

      return reply.send({ ok: true, company_rccm: data.company_rccm, company_idnat: data.company_idnat });
    },
  );

  /* ── POST /v1/admin/merchants/:id/test-webhook ────────────── */
  /* Send a test POST to the merchant's webhook URL, signed with the
   * merchant's webhook_secret (X-UniPay-Signature header) — exactly
   * like the real delivery path in payment/callback.ts. Returns the
   * HTTP status, response time, and response body. */
  fastify.post<{ Params: { id: string } }>(
    '/admin/merchants/:id/test-webhook',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }
      const { id } = request.params;

      const { data: merchant, error: mError } = await fastify.supabase
        .from('merchants')
        .select('webhook_url, webhook_secret')
        .eq('id', id)
        .maybeSingle();

      if (mError) return reply.status(500).send({ error: mError.message });
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });

      const webhookUrl = (merchant as { webhook_url?: string | null })?.webhook_url;
      const webhookSecret = (merchant as { webhook_secret?: string | null })?.webhook_secret;
      if (!webhookUrl) {
        return reply.status(400).send({
          error: 'NO_WEBHOOK_URL',
          message: 'Aucun webhook configuré pour ce marchand.',
          statusCode: 400,
        });
      }

      // Build a clearly-identifiable test payload matching the real
      // delivery shape (event + timestamp + data), so the merchant can
      // validate their signature verification end-to-end.
      const testPayload = {
        event: 'webhook.test',
        timestamp: new Date().toISOString(),
        data: {
          is_test: true,
          transaction_id: `test_${crypto.randomUUID().slice(0, 8)}`,
          status: 'success',
          amount: 0,
          currency: 'CDF',
          reference: 'TEST-WEBHOOK',
          message: 'Ceci est un test de webhook UniPay — aucune transaction réelle.',
        },
      };
      const payloadStr = JSON.stringify(testPayload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Unipay-Test': 'true',
      };
      if (webhookSecret) {
        const sig = crypto.createHmac('sha256', webhookSecret).update(payloadStr).digest('hex');
        headers['X-UniPay-Signature'] = `sha256=${sig}`;
      }

      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body: payloadStr,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const elapsedMs = Date.now() - startTime;
        const bodyText = await res.text().catch(() => '');
        // Truncate body to 2000 chars to avoid huge responses
        const bodyPreview = bodyText.length > 2000 ? bodyText.slice(0, 2000) + '…' : bodyText;

        void logAdminAction(fastify.supabase, 'merchant.test_webhook', 'merchant', id, { webhook_url: webhookUrl, http_status: res.status, elapsed_ms: elapsedMs }, fastify.log);

        return reply.send({
          ok: res.ok,
          http_status: res.status,
          elapsed_ms: elapsedMs,
          body: bodyPreview,
          content_type: res.headers.get('content-type'),
          signed: !!webhookSecret,
        });
      } catch (err: any) {
        const elapsedMs = Date.now() - startTime;
        const isTimeout = err?.name === 'AbortError';
        return reply.status(502).send({
          error: isTimeout ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_UNREACHABLE',
          message: isTimeout
            ? 'Le webhook n\'a pas répondu dans les 10 secondes.'
            : `Impossible de joindre le webhook: ${err?.message ?? 'unknown error'}`,
          elapsed_ms: elapsedMs,
          statusCode: 502,
        });
      }
    },
  );

  /* ── GET /v1/admin/merchants/transactions ──────────────────── */
  fastify.get<{ Querystring: MerchantTransactionsQuery }>(
    '/admin/merchants/transactions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:        { type: 'integer', minimum: 1, default: 1 },
            limit:       { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            merchant_id: { type: 'string', format: 'uuid' },
            status:      { type: 'string' },
            operator:    { type: 'string' },
            direction:   { type: 'string' },
            mode:        { type: 'string', enum: ['sandbox', 'live'] },
            date_from:   { type: 'string' },
            date_to:     { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 50;
      const offset = (page - 1) * limit;

      // If mode filter is set, fetch matching merchant IDs first so we
      // can filter transactions by merchant mode (mode is on the merchants
      // table, not transactions). This keeps pagination/count correct.
      let modeMerchantIds: string[] | null = null;
      if (request.query.mode) {
        const { data: modeMerchants } = await fastify.supabase
          .from('merchants')
          .select('id')
          .eq('mode', request.query.mode);
        modeMerchantIds = (modeMerchants ?? []).map((m: { id: string }) => m.id);
        if (modeMerchantIds.length === 0) {
          // No merchants match this mode — return empty result
          return reply.send({
            data: [],
            pagination: { page, limit, total: 0, pages: 0 },
          });
        }
      }

      // Fetch transactions without the PostgREST nested select — the FK
      // from transactions.merchant_id may point to operators(id) instead
      // of merchants(id) depending on which migration was applied first
      // (see 20260719000000_fix_transactions_merchant_id_type.sql). Fetching
      // merchant names separately is more robust and mirrors the pattern
      // used by the /admin/merchants/revenue endpoint.
      let q = fastify.supabase
        .from('transactions')
        .select(
          'id, merchant_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, avada_transaction_id, created_at, updated_at',
          { count: 'exact' },
        )
        .not('merchant_id', 'is', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (request.query.merchant_id) q = q.eq('merchant_id', request.query.merchant_id);
      if (request.query.status) q = q.eq('status', request.query.status);
      if (request.query.operator) q = q.eq('operator', request.query.operator);
      if (request.query.direction) q = q.eq('direction', request.query.direction);
      if (request.query.date_from) q = q.gte('created_at', request.query.date_from);
      if (request.query.date_to) q = q.lte('created_at', request.query.date_to);
      if (modeMerchantIds) q = q.in('merchant_id', modeMerchantIds);

      const { data, error, count } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      // Fetch merchant names separately and join
      const txs = (data ?? []) as Array<{ merchant_id: string }>;
      const merchantIds = [...new Set(txs.map((t) => t.merchant_id))];
      const merchantMap = new Map<string, { name: string; email: string; mode: string }>();

      if (merchantIds.length > 0) {
        const { data: merchants } = await fastify.supabase
          .from('merchants')
          .select('id, name, email, mode')
          .in('id', merchantIds);

        for (const m of (merchants ?? []) as Array<{ id: string; name: string; email: string; mode: string }>) {
          merchantMap.set(m.id, { name: m.name, email: m.email, mode: m.mode });
        }
      }

      // Attach merchant info in the format the frontend expects (merchants array)
      const dataWithMerchants = txs.map((t) => ({
        ...t,
        merchants: merchantMap.has(t.merchant_id)
          ? [merchantMap.get(t.merchant_id)!]
          : null,
      }));

      return reply.send({
        data: dataWithMerchants,
        pagination: {
          page,
          limit,
          total: count ?? 0,
          pages: Math.ceil((count ?? 0) / limit),
        },
      });
    },
  );

  /* ── GET /v1/admin/merchants/transactions/export ───────────── */
  fastify.get<{ Querystring: MerchantTransactionsQuery }>(
    '/admin/merchants/transactions/export',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            merchant_id: { type: 'string', format: 'uuid' },
            status:      { type: 'string', enum: ['pending', 'processing', 'success', 'failed', 'cancelled'] },
            operator:    { type: 'string', enum: ['orange', 'airtel', 'afrimoney', 'usdt'] },
            direction:   { type: 'string', enum: ['collect', 'payout'] },
            mode:        { type: 'string', enum: ['sandbox', 'live'] },
            date_from:   { type: 'string', format: 'date-time' },
            date_to:     { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      // If mode filter is set, fetch matching merchant IDs first
      let modeMerchantIds: string[] | null = null;
      if (request.query.mode) {
        const { data: modeMerchants } = await fastify.supabase
          .from('merchants')
          .select('id')
          .eq('mode', request.query.mode);
        modeMerchantIds = (modeMerchants ?? []).map((m: { id: string }) => m.id);
        if (modeMerchantIds.length === 0) {
          // No merchants match this mode — return empty CSV
          return reply
            .type('text/csv')
            .header('Content-Disposition', 'attachment; filename="merchant-transactions-empty.csv"')
            .send('date,marchand,email,type,operateur,telephone,montant,frais,net,statut,reference\n');
        }
      }

      let q = fastify.supabase
        .from('transactions')
        .select(
          'id, merchant_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at',
        )
        .not('merchant_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5000);

      if (request.query.merchant_id) q = q.eq('merchant_id', request.query.merchant_id);
      if (request.query.status) q = q.eq('status', request.query.status);
      if (request.query.operator) q = q.eq('operator', request.query.operator);
      if (request.query.direction) q = q.eq('direction', request.query.direction);
      if (request.query.date_from) q = q.gte('created_at', request.query.date_from);
      if (request.query.date_to) q = q.lte('created_at', request.query.date_to);
      if (modeMerchantIds) q = q.in('merchant_id', modeMerchantIds);

      const { data, error } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      // Fetch merchant names separately (same fix as the list endpoint)
      const txs = (data ?? []) as Array<{ merchant_id: string }>;
      const merchantIds = [...new Set(txs.map((t) => t.merchant_id))];
      const merchantMap = new Map<string, { name: string; email: string }>();

      if (merchantIds.length > 0) {
        const { data: merchants } = await fastify.supabase
          .from('merchants')
          .select('id, name, email')
          .in('id', merchantIds);

        for (const m of (merchants ?? []) as Array<{ id: string; name: string; email: string }>) {
          merchantMap.set(m.id, { name: m.name, email: m.email });
        }
      }

      const header = 'date,marchand,email,type,operateur,telephone,montant,frais,net,devise,statut,reference\n';
      const csv = txs
        .map((t) => {
          const tx = t as {
            created_at: string; merchant_id: string;
            direction: string; operator: string; phone: string; amount: string | number;
            fee: string | number; net_amount: string | number; currency: string;
            status: string; reference: string | null;
          };
          const m = merchantMap.get(tx.merchant_id);
          const mName = m?.name ?? '';
          const mEmail = m?.email ?? '';
          return [
            tx.created_at, mName, mEmail, tx.direction, tx.operator, tx.phone,
            tx.amount, tx.fee, tx.net_amount, tx.currency, tx.status, tx.reference ?? '',
          ].join(',');
        })
        .join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="merchant-transactions.csv"');
      return reply.send(header + csv);
    },
  );

  /* ── POST /v1/admin/merchants/:id/api-keys/revoke ──────────── */
  fastify.post<{ Params: { id: string }; Body: { key_id: string } }>(
    '/admin/merchants/:id/api-keys/revoke',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key_id'],
          properties: {
            key_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;
      const { key_id } = request.body;

      const { data, error } = await fastify.supabase
        .from('api_keys')
        .update({ is_active: false })
        .eq('id', key_id)
        .eq('merchant_id', id)
        .select('id, key_prefix, label, is_active')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'API key not found for this merchant' });

      fastify.log.info(
        { merchantId: id, keyId: key_id, adminAction: 'revoke_api_key' },
        '[admin] API key revoked',
      );
      void logAdminAction(fastify.supabase, 'merchant.api_key_revoke', 'merchant', id, { key_id, key_prefix: data.key_prefix }, fastify.log);

      // Auto-send "Révocation de clé API" email (fire-and-forget, non-blocking)
      // Fetch merchant data for template generation
      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, phone, kyc_status, mode, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at')
        .eq('id', id)
        .maybeSingle();

      if (merchant) {
        const m = merchant as MerchantTemplateData;
        const revokedLabel = (data as { label?: string }).label ?? data.key_prefix;
        void sendTemplateAuto('merchant', m, m.email, 'Révocation de clé API', { api_key_label: revokedLabel })
          .then((res) => {
            if (res.sent) {
              fastify.log.info({ merchantId: id, template: res.templateLabel }, '[admin-auto-email] API key revocation email sent');
            } else {
              fastify.log.warn({ merchantId: id, template: res.templateLabel, error: res.error }, '[admin-auto-email] API key revocation email NOT sent');
            }
          });
      }

      return reply.send({ ok: true, key: data });
    },
  );

  /* ── POST /v1/admin/merchants/:id/api-keys/regenerate ──────── */
  fastify.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/admin/merchants/:id/api-keys/regenerate',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;
      const label = request.body?.label ?? 'admin-regenerated';

      // Verify merchant exists
      const { data: merchant, error: mError } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, phone, kyc_status, mode, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at')
        .eq('id', id)
        .maybeSingle();

      if (mError) return reply.status(500).send({ error: mError.message });
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' });

      // Deactivate all existing active keys for this merchant
      await fastify.supabase
        .from('api_keys')
        .update({ is_active: false })
        .eq('merchant_id', id)
        .eq('is_active', true);

      // Generate new key
      const rawKey = `up_${crypto.randomBytes(16).toString('hex')}`;
      const keyPrefix = rawKey.slice(0, 12);
      const keyHash = await bcrypt.hash(rawKey, 10);

      const { error: insertError } = await fastify.supabase.from('api_keys').insert({
        merchant_id: id,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        label,
        is_active: true,
      });

      if (insertError) {
        fastify.log.error({ err: insertError, merchantId: id }, '[admin] API key regeneration failed');
        return reply.status(500).send({ error: 'Key generation failed' });
      }

      fastify.log.info(
        { merchantId: id, merchantEmail: (merchant as { email: string }).email, adminAction: 'regenerate_api_key' },
        '[admin] API key regenerated',
      );
      void logAdminAction(fastify.supabase, 'merchant.api_key_regenerate', 'merchant', id, { key_prefix: keyPrefix, label: label ?? null }, fastify.log);

      // Auto-send "Régénération de clé API" email (fire-and-forget, non-blocking)
      const m = merchant as MerchantTemplateData;
      void sendTemplateAuto('merchant', m, m.email, 'Régénération de clé API', { api_key_label: label })
        .then((res) => {
          if (res.sent) {
            fastify.log.info({ merchantId: id, template: res.templateLabel }, '[admin-auto-email] API key regeneration email sent');
          } else {
            fastify.log.warn({ merchantId: id, template: res.templateLabel, error: res.error }, '[admin-auto-email] API key regeneration email NOT sent');
          }
        });

      return reply.send({
        ok: true,
        api_key: rawKey,
        key_prefix: keyPrefix,
        label,
        note: 'Store this key securely — it will not be shown again.',
      });
    },
  );

  /* ── POST /v1/admin/merchants/:id/mode ─────────────────────── */
  fastify.post<{ Params: { id: string }; Body: { mode: string } }>(
    '/admin/merchants/:id/mode',
    {
      schema: {
        body: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['sandbox', 'live'] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;
      const { mode } = request.body;

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({ mode })
        .eq('id', id)
        .select('id, email, mode')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      fastify.log.info({ merchantId: id, mode }, '[admin] merchant mode updated');
      return reply.send({ ok: true, merchant: data });
    },
  );

  /* ── POST /v1/admin/merchants/:id/kyc/approve ──────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/merchants/:id/kyc/approve',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }
      const { id } = request.params;

      // If the merchant sent their documents by email (no form submission),
      // kyc_submitted_at is null — stamp it now so the admin validation is
      // fully traceable.
      const { data: before } = await fastify.supabase
        .from('merchants')
        .select('kyc_submitted_at')
        .eq('id', id)
        .maybeSingle();
      const submittedAt = (before as { kyc_submitted_at?: string | null } | null)?.kyc_submitted_at;
      const nowIso = new Date().toISOString();

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({
          kyc_status:      'approved',
          kyc_reviewed_at: nowIso,
          kyc_notes:       null,
          mode:            'live',
          ...(submittedAt ? {} : { kyc_submitted_at: nowIso }),
        })
        .eq('id', id)
        .select('id, name, email, phone, kyc_status, mode, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });
      fastify.log.info({ merchantId: id }, '[admin] KYC approved, mode set to live');
      void logAdminAction(fastify.supabase, 'merchant.kyc_approve', 'merchant', id, { previous_mode: 'sandbox', new_mode: 'live' }, fastify.log);

      // Auto-send "KYC approuvé" email (fire-and-forget, non-blocking)
      const m = data as MerchantTemplateData;
      void sendTemplateAuto('merchant', m, m.email, 'KYC approuvé')
        .then((res) => {
          if (res.sent) {
            fastify.log.info({ merchantId: id, template: res.templateLabel }, '[admin-auto-email] KYC approved email sent');
          } else {
            fastify.log.warn({ merchantId: id, template: res.templateLabel, error: res.error }, '[admin-auto-email] KYC approved email NOT sent');
          }
        });

      return reply.send({ ok: true, merchant: data });
    },
  );

  /* ── POST /v1/admin/merchants/:id/kyc/reject ───────────────── */
  fastify.post<{ Params: { id: string }; Body: { notes?: string } }>(
    '/admin/merchants/:id/kyc/reject',
    {
      schema: {
        body: {
          type: 'object',
          properties: { notes: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }
      const { id } = request.params;
      const notes = request.body?.notes ?? null;
      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({
          kyc_status:      'rejected',
          kyc_reviewed_at: new Date().toISOString(),
          kyc_notes:       notes,
        })
        .eq('id', id)
        .select('id, email, kyc_status')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });
      fastify.log.info({ merchantId: id, notes }, '[admin] KYC rejected');
      void logAdminAction(fastify.supabase, 'merchant.kyc_reject', 'merchant', id, { notes: notes ?? null }, fastify.log);
      return reply.send({ ok: true, merchant: data });
    },
  );

  /* ── POST /v1/admin/merchants/:id/suspend ──────────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/merchants/:id/suspend',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({ status: 'suspended' })
        .eq('id', id)
        .select('id, name, email, status')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      fastify.log.info(
        { merchantId: id, adminAction: 'suspend_merchant' },
        '[admin] Merchant suspended',
      );
      void logAdminAction(fastify.supabase, 'merchant.suspend', 'merchant', id, {}, fastify.log);
      return reply.send({ ok: true, merchant: data });
    },
  );

  /* ── POST /v1/admin/merchants/:id/reactivate ───────────────── */
  fastify.post<{ Params: { id: string } }>(
    '/admin/merchants/:id/reactivate',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({ status: 'active' })
        .eq('id', id)
        .select('id, name, email, phone, kyc_status, mode, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      fastify.log.info(
        { merchantId: id, adminAction: 'reactivate_merchant' },
        '[admin] Merchant reactivated',
      );
      void logAdminAction(fastify.supabase, 'merchant.reactivate', 'merchant', id, {}, fastify.log);

      // Auto-send "Compte réactivé" email (fire-and-forget, non-blocking)
      const m = data as MerchantTemplateData;
      void sendTemplateAuto('merchant', m, m.email, 'Compte réactivé')
        .then((res) => {
          if (res.sent) {
            fastify.log.info({ merchantId: id, template: res.templateLabel }, '[admin-auto-email] Reactivation email sent');
          } else {
            fastify.log.warn({ merchantId: id, template: res.templateLabel, error: res.error }, '[admin-auto-email] Reactivation email NOT sent');
          }
        });

      return reply.send({ ok: true, merchant: data });
    },
  );

  /* ── GET /v1/admin/merchants/:id/support-templates ─────────── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/merchants/:id/support-templates',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('name, email, phone, kyc_status, mode, status, company_name, company_rccm, company_idnat, kyc_notes, kyc_submitted_at, kyc_reviewed_at')
        .eq('id', id)
        .maybeSingle();

      if (error || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found' });
      }

      const m = merchant as MerchantTemplateData;
      const templates = buildEmailTemplates('merchant', m);

      return reply.send({ templates });
    },
  );

  /* ── POST /v1/admin/merchants/:id/email ────────────────────── */
  fastify.post<{ Params: { id: string }; Body: { subject: string; body: string; conversation_id?: string; template_label?: string } }>(
    '/admin/merchants/:id/email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['subject', 'body'],
          properties: {
            subject:        { type: 'string', minLength: 1, maxLength: 256 },
            body:           { type: 'string', minLength: 1, maxLength: 8000 },
            conversation_id: { type: 'string', format: 'uuid' },
            template_label: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;
      const { subject, body, conversation_id, template_label } = request.body;

      // Fetch merchant — CRITICAL: use the merchant's own email, never an arbitrary address
      const { data: merchant, error: merchantError } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, status')
        .eq('id', id)
        .maybeSingle();

      if (merchantError || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found' });
      }

      const m = merchant as { id: string; name: string; email: string; status: string };

      // Find or create conversation — always scoped to THIS merchant
      let conversationId = conversation_id;
      if (conversationId) {
        const { data: conv, error: convError } = await fastify.supabase
          .from('support_conversations')
          .select('id, merchant_id')
          .eq('id', conversationId)
          .eq('merchant_id', id) // CRITICAL: verify ownership
          .maybeSingle();

        if (convError || !conv) {
          return reply.status(404).send({ error: 'Conversation not found for this merchant' });
        }
      } else {
        // Reuse most recent open conversation, or create new
        const { data: recentConv } = await fastify.supabase
          .from('support_conversations')
          .select('id')
          .eq('merchant_id', id)
          .in('status', ['open', 'escalated'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recentConv) {
          conversationId = (recentConv as { id: string }).id;
        } else {
          const { data: newConv, error: createError } = await fastify.supabase
            .from('support_conversations')
            .insert({ merchant_id: id, status: 'open' })
            .select('id')
            .single();

          if (createError || !newConv) {
            fastify.log.error({ err: createError, merchantId: id }, '[admin-email] conversation creation failed');
            return reply.status(500).send({ error: 'Failed to create conversation' });
          }
          conversationId = newConv.id;
        }
      }

      // Send the email to the merchant's verified address
      try {
        await sendAdminDirectEmail(m.email, subject, body);
      } catch (err) {
        fastify.log.error({ err, merchantId: id, to: m.email }, '[admin-email] email send failed');
        return reply.status(500).send({ error: 'Failed to send email' });
      }

      // Log the message in support_messages with channel='email'
      const { error: msgError } = await fastify.supabase
        .from('support_messages')
        .insert({
          conversation_id: conversationId,
          role: 'admin',
          channel: 'email',
          subject,
          content: body,
          template_label: template_label ?? null,
        });

      if (msgError) {
        fastify.log.error({ err: msgError, conversationId }, '[admin-email] message log failed');
      }

      fastify.log.info(
        { merchantId: id, conversationId, adminAction: 'direct_email', to: m.email, subject },
        '[admin] Direct email sent to merchant',
      );

      return reply.send({
        ok: true,
        conversation_id: conversationId,
        sent_to: m.email,
      });
    },
  );

  /* ── GET /v1/admin/merchants/:id/email-history-summary ─────── */
  /* Returns, grouped by template_label, the count and last_sent_at
   * for emails sent to this merchant. Only channel='email'. */
  fastify.get<{ Params: { id: string } }>(
    '/admin/merchants/:id/email-history-summary',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      // Verify merchant exists
      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('id')
        .eq('id', id)
        .maybeSingle();

      if (!merchant) {
        return reply.status(404).send({ error: 'Merchant not found' });
      }

      // Fetch all email messages with template_label for this merchant's conversations
      const { data: messages, error } = await fastify.supabase
        .from('support_messages')
        .select('template_label, created_at, conversation_id')
        .eq('channel', 'email')
        .not('template_label', 'is', null)
        .order('created_at', { ascending: false });

      if (error) {
        fastify.log.error({ err: error }, '[admin/email-history-summary] query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      // Filter to only messages belonging to this merchant's conversations
      // We need to get the merchant's conversation IDs first
      const { data: convs } = await fastify.supabase
        .from('support_conversations')
        .select('id')
        .eq('merchant_id', id);

      const convIds = new Set((convs ?? []).map((c: { id: string }) => c.id));

      const filtered = (messages ?? []).filter(
        (m: { conversation_id: string; template_label: string; created_at: string }) =>
          convIds.has(m.conversation_id),
      );

      // Group by template_label
      const summaryMap = new Map<string, { template_label: string; count: number; last_sent_at: string }>();
      for (const m of filtered) {
        const label = m.template_label as string;
        const existing = summaryMap.get(label);
        if (existing) {
          existing.count += 1;
          if (m.created_at > existing.last_sent_at) {
            existing.last_sent_at = m.created_at;
          }
        } else {
          summaryMap.set(label, {
            template_label: label,
            count: 1,
            last_sent_at: m.created_at,
          });
        }
      }

      const summary = Array.from(summaryMap.values()).sort((a, b) => b.last_sent_at.localeCompare(a.last_sent_at));

      return reply.send({ summary });
    },
  );

  /* ── GET /v1/admin/merchants/revenue ────────────────────────── */
  /* Per-merchant revenue breakdown with period filters. */
  interface RevenueQuery {
    from?: string;
    to?: string;
    sort?: string;
  }

  const AVADA_FEE_RATE = 0.03;
  const CLIENT_FEE_RATE = Number(env.MERCHANT_FEE_RATE); // 0.05 default
  const MARGIN_RATE = CLIENT_FEE_RATE - AVADA_FEE_RATE; // 0.02

  fastify.get<{ Querystring: RevenueQuery }>(
    '/admin/merchants/revenue',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from:  { type: 'string', format: 'date' },
            to:    { type: 'string', format: 'date' },
            sort:  { type: 'string', enum: ['volume', 'margin', 'tx_count'], default: 'margin' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const now = new Date();
      const toDate = request.query.to
        ? new Date(request.query.to + 'T23:59:59.999Z')
        : new Date(now.toISOString());
      const fromDate = request.query.from
        ? new Date(request.query.from + 'T00:00:00.000Z')
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return reply.status(400).send({ error: 'Invalid date format', statusCode: 400 });
      }

      // Fetch all successful collect transactions in the period
      const { data: txs, error } = await fastify.supabase
        .from('transactions')
        .select('merchant_id, amount, fee, net_amount, currency')
        .eq('status', 'success')
        .eq('direction', 'collect')
        .not('merchant_id', 'is', null)
        .gte('created_at', fromDate.toISOString())
        .lte('created_at', toDate.toISOString())
        .limit(100000);

      if (error) {
        fastify.log.error({ err: error }, '[admin/merchants/revenue] query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      // Fetch merchant names + mode (sandbox transactions are excluded
      // from revenue — they are simulated, not real money movements)
      const merchantIds = [...new Set((txs ?? []).map((t: { merchant_id: string }) => t.merchant_id))];
      const { data: merchants } = await fastify.supabase
        .from('merchants')
        .select('id, name, mode')
        .in('id', merchantIds);

      const merchantNames = new Map<string, string>(
        (merchants ?? []).map((m: { id: string; name: string }) => [m.id, m.name]),
      );
      const sandboxMerchantIds = new Set<string>(
        (merchants ?? [])
          .filter((m: { mode: string }) => m.mode === 'sandbox')
          .map((m: { id: string }) => m.id),
      );

      // Exclude sandbox transactions from revenue calculations
      const liveTxs = (txs ?? []).filter((t: { merchant_id: string }) => !sandboxMerchantIds.has(t.merchant_id));
      const sandboxTxs = (txs ?? []).filter((t: { merchant_id: string }) => sandboxMerchantIds.has(t.merchant_id));

      // Sandbox-excluded summary (indicative only — not included in totals)
      const sandbox_excluded = {
        transaction_count: sandboxTxs.length,
        volume_collected: Math.round(
          sandboxTxs.reduce((s, t: { amount?: number | null }) => s + Number(t.amount ?? 0), 0) * 100,
        ) / 100,
        by_currency: (() => {
          const map = new Map<string, { currency: string; transaction_count: number; volume_collected: number }>();
          for (const t of sandboxTxs) {
            const cur = ((t as { currency?: string }).currency ?? 'CDF') as string;
            if (!map.has(cur)) map.set(cur, { currency: cur, transaction_count: 0, volume_collected: 0 });
            const e = map.get(cur)!;
            e.transaction_count += 1;
            e.volume_collected += Number((t as { amount?: number | null }).amount ?? 0);
          }
          return Array.from(map.values()).map((e) => ({
            ...e,
            volume_collected: Math.round(e.volume_collected * 100) / 100,
          }));
        })(),
      };

      // Aggregate per merchant + per currency
      const perMerchant = new Map<string, {
        merchant_id: string;
        name: string;
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
        currencies: Map<string, {
          currency: string;
          transaction_count: number;
          volume_collected: number;
          client_fees: number;
          avada_cost: number;
          net_margin: number;
          net_amount_owed: number;
        }>;
      }>();

      for (const tx of liveTxs) {
        const mid = tx.merchant_id as string;
        const cur = (tx.currency ?? 'CDF') as string;
        if (!perMerchant.has(mid)) {
          perMerchant.set(mid, {
            merchant_id: mid,
            name: merchantNames.get(mid) ?? 'Unknown',
            transaction_count: 0,
            volume_collected: 0,
            client_fees: 0,
            avada_cost: 0,
            net_margin: 0,
            net_amount_owed: 0,
            currencies: new Map(),
          });
        }
        const entry = perMerchant.get(mid)!;
        const amount = Number(tx.amount ?? 0);
        const fee = Number(tx.fee ?? 0);
        const netAmount = Number(tx.net_amount ?? 0);

        // Per-merchant totals (mixed currency — for backward compat sorting)
        entry.transaction_count += 1;
        entry.volume_collected += amount;
        entry.client_fees += fee;
        entry.avada_cost += amount * AVADA_FEE_RATE;
        entry.net_margin += amount * MARGIN_RATE;
        entry.net_amount_owed += netAmount;

        // Per-currency breakdown
        if (!entry.currencies.has(cur)) {
          entry.currencies.set(cur, {
            currency: cur,
            transaction_count: 0,
            volume_collected: 0,
            client_fees: 0,
            avada_cost: 0,
            net_margin: 0,
            net_amount_owed: 0,
          });
        }
        const curEntry = entry.currencies.get(cur)!;
        curEntry.transaction_count += 1;
        curEntry.volume_collected += amount;
        curEntry.client_fees += fee;
        curEntry.avada_cost += amount * AVADA_FEE_RATE;
        curEntry.net_margin += amount * MARGIN_RATE;
        curEntry.net_amount_owed += netAmount;
      }

      // Round values + convert currencies map to array
      let merchants_array = Array.from(perMerchant.values()).map((e) => ({
        merchant_id: e.merchant_id,
        name: e.name,
        mode: sandboxMerchantIds.has(e.merchant_id) ? 'sandbox' : 'live',
        transaction_count: e.transaction_count,
        volume_collected: Math.round(e.volume_collected * 100) / 100,
        client_fees: Math.round(e.client_fees * 100) / 100,
        avada_cost: Math.round(e.avada_cost * 100) / 100,
        net_margin: Math.round(e.net_margin * 100) / 100,
        net_amount_owed: Math.round(e.net_amount_owed * 100) / 100,
        by_currency: Array.from(e.currencies.values()).map((c) => ({
          currency: c.currency,
          transaction_count: c.transaction_count,
          volume_collected: Math.round(c.volume_collected * 100) / 100,
          client_fees: Math.round(c.client_fees * 100) / 100,
          avada_cost: Math.round(c.avada_cost * 100) / 100,
          net_margin: Math.round(c.net_margin * 100) / 100,
          net_amount_owed: Math.round(c.net_amount_owed * 100) / 100,
        })),
      }));

      // Sort
      const sortBy = request.query.sort ?? 'margin';
      merchants_array.sort((a, b) => {
        if (sortBy === 'volume') return b.volume_collected - a.volume_collected;
        if (sortBy === 'tx_count') return b.transaction_count - a.transaction_count;
        return b.net_margin - a.net_margin; // default: margin
      });

      // Totals (mixed currency — for backward compat)
      const totals = {
        transaction_count: merchants_array.reduce((s, e) => s + e.transaction_count, 0),
        volume_collected: Math.round(merchants_array.reduce((s, e) => s + e.volume_collected, 0) * 100) / 100,
        client_fees: Math.round(merchants_array.reduce((s, e) => s + e.client_fees, 0) * 100) / 100,
        avada_cost: Math.round(merchants_array.reduce((s, e) => s + e.avada_cost, 0) * 100) / 100,
        net_margin: Math.round(merchants_array.reduce((s, e) => s + e.net_margin, 0) * 100) / 100,
        net_amount_owed: Math.round(merchants_array.reduce((s, e) => s + e.net_amount_owed, 0) * 100) / 100,
        merchant_count: merchants_array.length,
      };

      // Totals per currency (never mixed)
      // CDF and USD are always included even at 0, so the admin sees parity
      // with the merchant portal. USDT only if ledger entries exist.
      const byCurrencyTotals: Record<string, {
        currency: string;
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
      }> = {};

      // Seed always-visible currencies at 0
      for (const cur of ['CDF', 'USD']) {
        byCurrencyTotals[cur] = {
          currency: cur,
          transaction_count: 0,
          volume_collected: 0,
          client_fees: 0,
          avada_cost: 0,
          net_margin: 0,
          net_amount_owed: 0,
        };
      }

      for (const m of merchants_array) {
        for (const c of m.by_currency) {
          if (!byCurrencyTotals[c.currency]) {
            byCurrencyTotals[c.currency] = {
              currency: c.currency,
              transaction_count: 0,
              volume_collected: 0,
              client_fees: 0,
              avada_cost: 0,
              net_margin: 0,
              net_amount_owed: 0,
            };
          }
          byCurrencyTotals[c.currency].transaction_count += c.transaction_count;
          byCurrencyTotals[c.currency].volume_collected += c.volume_collected;
          byCurrencyTotals[c.currency].client_fees += c.client_fees;
          byCurrencyTotals[c.currency].avada_cost += c.avada_cost;
          byCurrencyTotals[c.currency].net_margin += c.net_margin;
          byCurrencyTotals[c.currency].net_amount_owed += c.net_amount_owed;
        }
      }

      // Order: CDF first, USD second, then any others (USDT) sorted
      const currencyOrder = ['CDF', 'USD', 'USDT'];
      const totalsByCurrencySorted = [
        ...currencyOrder.filter((c) => byCurrencyTotals[c]),
        ...Object.keys(byCurrencyTotals).filter((c) => !currencyOrder.includes(c)).sort(),
      ];

      const totals_by_currency = totalsByCurrencySorted.map((cur) => {
        const c = byCurrencyTotals[cur];
        return {
          ...c,
          volume_collected: Math.round(c.volume_collected * 100) / 100,
          client_fees: Math.round(c.client_fees * 100) / 100,
          avada_cost: Math.round(c.avada_cost * 100) / 100,
          net_margin: Math.round(c.net_margin * 100) / 100,
          net_amount_owed: Math.round(c.net_amount_owed * 100) / 100,
        };
      });

      return reply.send({
        period: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        totals,
        totals_by_currency,
        sandbox_excluded,
        merchants: merchants_array,
      });
    },
  );

  /* ── GET /v1/admin/merchants/revenue/export ─────────────────── */
  fastify.get<{ Querystring: RevenueQuery }>(
    '/admin/merchants/revenue/export',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from:  { type: 'string', format: 'date' },
            to:    { type: 'string', format: 'date' },
            sort:  { type: 'string', enum: ['volume', 'margin', 'tx_count'], default: 'margin' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const now = new Date();
      const toDate = request.query.to
        ? new Date(request.query.to + 'T23:59:59.999Z')
        : new Date(now.toISOString());
      const fromDate = request.query.from
        ? new Date(request.query.from + 'T00:00:00.000Z')
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const { data: txs, error } = await fastify.supabase
        .from('transactions')
        .select('merchant_id, amount, fee, net_amount, currency')
        .eq('status', 'success')
        .eq('direction', 'collect')
        .not('merchant_id', 'is', null)
        .gte('created_at', fromDate.toISOString())
        .lte('created_at', toDate.toISOString())
        .limit(100000);

      if (error) {
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      const merchantIds = [...new Set((txs ?? []).map((t: { merchant_id: string }) => t.merchant_id))];
      const { data: merchants } = await fastify.supabase
        .from('merchants')
        .select('id, name, mode')
        .in('id', merchantIds);

      const merchantNames = new Map<string, string>(
        (merchants ?? []).map((m: { id: string; name: string }) => [m.id, m.name]),
      );
      const sandboxMerchantIds = new Set<string>(
        (merchants ?? [])
          .filter((m: { mode: string }) => m.mode === 'sandbox')
          .map((m: { id: string }) => m.id),
      );

      // Exclude sandbox transactions from revenue calculations
      const liveTxs = (txs ?? []).filter((t: { merchant_id: string }) => !sandboxMerchantIds.has(t.merchant_id));

      // Aggregate per merchant + per currency (never mix currencies in a row)
      const perMerchantCurrency = new Map<string, {
        name: string;
        currency: string;
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
      }>();

      for (const tx of liveTxs) {
        const mid = tx.merchant_id as string;
        const cur = (tx.currency ?? 'CDF') as string;
        const key = `${mid}:${cur}`;
        if (!perMerchantCurrency.has(key)) {
          perMerchantCurrency.set(key, {
            name: merchantNames.get(mid) ?? 'Unknown',
            currency: cur,
            transaction_count: 0,
            volume_collected: 0,
            client_fees: 0,
            avada_cost: 0,
            net_margin: 0,
            net_amount_owed: 0,
          });
        }
        const entry = perMerchantCurrency.get(key)!;
        const amount = Number(tx.amount ?? 0);
        entry.transaction_count += 1;
        entry.volume_collected += amount;
        entry.client_fees += Number(tx.fee ?? 0);
        entry.avada_cost += amount * AVADA_FEE_RATE;
        entry.net_margin += amount * MARGIN_RATE;
        entry.net_amount_owed += Number(tx.net_amount ?? 0);
      }

      const sortBy = request.query.sort ?? 'margin';
      const rows = Array.from(perMerchantCurrency.entries()).map(([key, e]) => ({
        merchant_id: key.split(':')[0],
        ...e,
        volume_collected: Math.round(e.volume_collected * 100) / 100,
        client_fees: Math.round(e.client_fees * 100) / 100,
        avada_cost: Math.round(e.avada_cost * 100) / 100,
        net_margin: Math.round(e.net_margin * 100) / 100,
        net_amount_owed: Math.round(e.net_amount_owed * 100) / 100,
      }));

      rows.sort((a, b) => {
        if (sortBy === 'volume') return b.volume_collected - a.volume_collected;
        if (sortBy === 'tx_count') return b.transaction_count - a.transaction_count;
        return b.net_margin - a.net_margin;
      });

      // Build CSV — one row per merchant + currency
      const headers = ['merchant_id', 'name', 'currency', 'transaction_count', 'volume_collected', 'client_fees', 'avada_cost', 'net_margin', 'net_amount_owed'];
      const csvLines = [headers.join(',')];
      for (const r of rows) {
        csvLines.push([
          r.merchant_id,
          `"${r.name.replace(/"/g, '""')}"`,
          r.currency,
          r.transaction_count,
          r.volume_collected,
          r.client_fees,
          r.avada_cost,
          r.net_margin,
          r.net_amount_owed,
        ].join(','));
      }

      // ── Totals per currency at the bottom (CDF + USD always, even at 0) ──
      // Compute from the rows we already have (per merchant + currency)
      const csvTotalsByCurrency: Record<string, {
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
      }> = {};
      for (const cur of ['CDF', 'USD']) {
        csvTotalsByCurrency[cur] = {
          transaction_count: 0, volume_collected: 0, client_fees: 0,
          avada_cost: 0, net_margin: 0, net_amount_owed: 0,
        };
      }
      for (const r of rows) {
        if (!csvTotalsByCurrency[r.currency]) {
          csvTotalsByCurrency[r.currency] = {
            transaction_count: 0, volume_collected: 0, client_fees: 0,
            avada_cost: 0, net_margin: 0, net_amount_owed: 0,
          };
        }
        csvTotalsByCurrency[r.currency].transaction_count += r.transaction_count;
        csvTotalsByCurrency[r.currency].volume_collected += r.volume_collected;
        csvTotalsByCurrency[r.currency].client_fees += r.client_fees;
        csvTotalsByCurrency[r.currency].avada_cost += r.avada_cost;
        csvTotalsByCurrency[r.currency].net_margin += r.net_margin;
        csvTotalsByCurrency[r.currency].net_amount_owed += r.net_amount_owed;
      }

      // Add a blank separator line then total rows
      csvLines.push('');
      for (const cur of ['CDF', 'USD', 'USDT']) {
        if (!csvTotalsByCurrency[cur]) continue;
        const t = csvTotalsByCurrency[cur];
        csvLines.push([
          `"TOTAL ${cur}"`,
          `"Total ${cur}"`,
          cur,
          t.transaction_count,
          Math.round(t.volume_collected * 100) / 100,
          Math.round(t.client_fees * 100) / 100,
          Math.round(t.avada_cost * 100) / 100,
          Math.round(t.net_margin * 100) / 100,
          Math.round(t.net_amount_owed * 100) / 100,
        ].join(','));
      }

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="merchant-revenue-${fromDate.toISOString().slice(0,10)}-to-${toDate.toISOString().slice(0,10)}.csv"`);
      return reply.send(csvLines.join('\n'));
    },
  );

  /* ── GET /v1/admin/merchants/revenue/daily ──────────────────── */
  /* Daily evolution of volume collected, UniPay margin, Avada cost, */
  /* and transaction count over a period. Used by the chart on the */
  /* revenue page. Aggregation by date is done server-side (GROUP BY */
  /* date) rather than client-side to avoid shipping raw transactions */
  /* to the browser on large volumes. */
  interface DailyRevenueQuery {
    from?: string;
    to?: string;
    merchant_id?: string;
  }

  fastify.get<{ Querystring: DailyRevenueQuery }>(
    '/admin/merchants/revenue/daily',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from:        { type: 'string', format: 'date' },
            to:          { type: 'string', format: 'date' },
            merchant_id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      const now = new Date();
      const toDate = request.query.to
        ? new Date(request.query.to + 'T23:59:59.999Z')
        : new Date(now.toISOString());
      const fromDate = request.query.from
        ? new Date(request.query.from + 'T00:00:00.000Z')
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return reply.status(400).send({ error: 'Invalid date format', statusCode: 400 });
      }

      // Fetch successful collect transactions in the period
      let query = fastify.supabase
        .from('transactions')
        .select('merchant_id, amount, currency, created_at')
        .eq('status', 'success')
        .eq('direction', 'collect')
        .not('merchant_id', 'is', null)
        .gte('created_at', fromDate.toISOString())
        .lte('created_at', toDate.toISOString())
        .limit(100000);

      if (request.query.merchant_id) {
        query = query.eq('merchant_id', request.query.merchant_id);
      }

      const { data: txs, error } = await query;

      if (error) {
        fastify.log.error({ err: error }, '[admin/merchants/revenue/daily] query failed');
        return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
      }

      // Exclude sandbox transactions from revenue calculations
      const merchantIds = [...new Set((txs ?? []).map((t: { merchant_id: string }) => t.merchant_id))];
      const { data: merchants } = await fastify.supabase
        .from('merchants')
        .select('id, mode')
        .in('id', merchantIds);
      const sandboxMerchantIds = new Set<string>(
        (merchants ?? [])
          .filter((m: { mode: string }) => m.mode === 'sandbox')
          .map((m: { id: string }) => m.id),
      );
      const liveTxs = (txs ?? []).filter((t: { merchant_id: string }) => !sandboxMerchantIds.has(t.merchant_id));

      // Aggregate by calendar date (UTC, consistent with the main revenue endpoint)
      const byDate = new Map<string, {
        date: string;
        volume_collected: number;
        net_margin: number;
        avada_cost: number;
        transaction_count: number;
      }>();

      for (const tx of liveTxs) {
        const dateStr = (tx.created_at as string).slice(0, 10); // YYYY-MM-DD
        if (!byDate.has(dateStr)) {
          byDate.set(dateStr, {
            date: dateStr,
            volume_collected: 0,
            net_margin: 0,
            avada_cost: 0,
            transaction_count: 0,
          });
        }
        const entry = byDate.get(dateStr)!;
        const amount = Number(tx.amount ?? 0);
        entry.volume_collected += amount;
        entry.net_margin += amount * MARGIN_RATE;
        entry.avada_cost += amount * AVADA_FEE_RATE;
        entry.transaction_count += 1;
      }

      // Fill missing dates in the range with zeros so the chart has no gaps
      const daily: Array<{
        date: string;
        volume_collected: number;
        net_margin: number;
        avada_cost: number;
        transaction_count: number;
      }> = [];

      const cursor = new Date(fromDate.toISOString().slice(0, 10) + 'T00:00:00.000Z');
      const endStr = toDate.toISOString().slice(0, 10);
      // Guard against an absurdly large range (e.g. bad custom input)
      let safety = 0;
      while (cursor.toISOString().slice(0, 10) <= endStr && safety < 400) {
        const ds = cursor.toISOString().slice(0, 10);
        const entry = byDate.get(ds);
        daily.push(entry ?? {
          date: ds,
          volume_collected: 0,
          net_margin: 0,
          avada_cost: 0,
          transaction_count: 0,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        safety += 1;
      }

      // Round monetary values
      const dailyRounded = daily.map((d) => ({
        date: d.date,
        volume_collected: Math.round(d.volume_collected * 100) / 100,
        net_margin: Math.round(d.net_margin * 100) / 100,
        avada_cost: Math.round(d.avada_cost * 100) / 100,
        transaction_count: d.transaction_count,
      }));

      return reply.send({
        period: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        daily: dailyRounded,
      });
    },
  );
};

export default adminMerchantsRoute;
