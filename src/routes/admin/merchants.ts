import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sendAdminDirectEmail } from '../../services/email.js';

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
            search:     { type: 'string' },
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
          'id, name, email, phone, country, mode, kyc_status, status, company_name, company_rccm, company_idnat, kyc_submitted_at, kyc_notes, kyc_reviewed_at, created_at, updated_at',
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
        return {
          ...m,
          transaction_count: stats.tx_count,
          total_volume: stats.total_volume,
          last_transaction_at: stats.last_tx_at,
          api_key_status: keys.key_count === 0 ? 'none' : keys.has_active_key ? 'active' : 'inactive',
          last_kyc_reminder_count: kycReminder.count,
          last_kyc_reminder_at: kycReminder.last_sent_at,
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

      const [merchantRes, keysRes, txRes] = await Promise.all([
        fastify.supabase
          .from('merchants')
          .select('id, name, email, phone, country, mode, kyc_status, status, company_name, company_rccm, company_idnat, kyc_submitted_at, kyc_notes, kyc_reviewed_at, created_at, updated_at')
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
      ]);

      if (merchantRes.error) return reply.status(500).send({ error: merchantRes.error.message });
      if (!merchantRes.data) return reply.status(404).send({ error: 'Merchant not found' });

      return reply.send({
        merchant: merchantRes.data,
        api_keys: keysRes.data ?? [],
        transactions: txRes.data ?? [],
      });
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

      let q = fastify.supabase
        .from('transactions')
        .select(
          'id, merchant_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, avada_transaction_id, created_at, updated_at, merchants(name, email)',
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

      const { data, error, count } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      return reply.send({
        data: data ?? [],
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
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      let q = fastify.supabase
        .from('transactions')
        .select(
          'id, merchant_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at, merchants(name, email)',
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

      const { data, error } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      const header = 'date,marchand,email,type,operateur,telephone,montant,frais,net,devise,statut,reference\n';
      const csv = (data ?? [])
        .map((t) => {
          const tx = t as {
            created_at: string; merchants: { name: string; email: string }[] | null;
            direction: string; operator: string; phone: string; amount: string | number;
            fee: string | number; net_amount: string | number; currency: string;
            status: string; reference: string | null;
          };
          const mName = tx.merchants?.[0]?.name ?? '';
          const mEmail = tx.merchants?.[0]?.email ?? '';
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
        .select('id, key_prefix, is_active')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'API key not found for this merchant' });

      fastify.log.info(
        { merchantId: id, keyId: key_id, adminAction: 'revoke_api_key' },
        '[admin] API key revoked',
      );
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
        .select('id, email, name')
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
      const { data, error } = await fastify.supabase
        .from('merchants')
        .update({
          kyc_status:      'approved',
          kyc_reviewed_at: new Date().toISOString(),
          kyc_notes:       null,
          mode:            'live',
        })
        .eq('id', id)
        .select('id, email, kyc_status, mode')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });
      fastify.log.info({ merchantId: id }, '[admin] KYC approved, mode set to live');
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
        .select('id, name, email, status')
        .maybeSingle();

      if (error) return reply.status(500).send({ error: error.message });
      if (!data) return reply.status(404).send({ error: 'Merchant not found' });

      fastify.log.info(
        { merchantId: id, adminAction: 'reactivate_merchant' },
        '[admin] Merchant reactivated',
      );
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
        .select('name, email, kyc_status, mode')
        .eq('id', id)
        .maybeSingle();

      if (error || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found' });
      }

      const m = merchant as { name: string; email: string; kyc_status: string; mode: string };
      const name = m.name ?? m.email;

      const templates: Array<{ label: string; subject: string; body: string }> = [];

      if (m.kyc_status === 'pending') {
        templates.push({
          label: 'Relance KYC',
          subject: 'Action requise : finalisation de votre KYC UniPay Congo',
          body: `Bonjour ${name},\n\nNous avons constaté que votre dossier KYC n'a pas encore été soumis. Sans KYC validé, votre compte reste en mode sandbox et vous ne pouvez pas traiter de paiements réels.\n\nPour soumettre votre dossier, rendez-vous dans votre tableau de bord → section KYC. Vous aurez besoin de :\n  - Votre pièce d'identité (IDNat ou passeport)\n  - Votre registre de commerce (RCCM)\n  - La raison sociale de votre entreprise\n\nUne fois le KYC approuvé, votre compte passera automatiquement en mode live.\n\nCordialement,\nL'équipe UniPay Congo`,
        });
      }

      if (m.kyc_status === 'submitted') {
        templates.push({
          label: 'KYC en cours de revue',
          subject: 'Votre dossier KYC est en cours de revue',
          body: `Bonjour ${name},\n\nNous accusons réception de votre dossier KYC. Notre équipe est actuellement en train de l'examiner. Vous recevrez une notification dès que la revue sera terminée.\n\nCe processus prend généralement 24 à 48 heures ouvrées.\n\nCordialement,\nL'équipe UniPay Congo`,
        });
      }

      if (m.kyc_status === 'approved' && m.mode === 'sandbox') {
        templates.push({
          label: 'Passage en mode live',
          subject: 'Votre KYC est approuvé — passez en mode live',
          body: `Bonjour ${name},\n\nBonne nouvelle : votre dossier KYC a été approuvé. Votre compte est actuellement en mode sandbox. Vous pouvez désormais passer en mode live pour traiter des paiements réels.\n\nPour activer le mode live, rendez-vous dans votre tableau de bord → Paramètres, ou contactez-nous si vous avez besoin d'assistance.\n\nCordialement,\nL'équipe UniPay Congo`,
        });
      }

      // Generic template — always available
      templates.push({
        label: 'Réponse à votre demande',
        subject: '',
        body: `Bonjour ${name},\n\n`,
      });

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
  const CLIENT_FEE_RATE = 0.04;
  const MARGIN_RATE = CLIENT_FEE_RATE - AVADA_FEE_RATE; // 0.01

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

      // Fetch merchant names
      const merchantIds = [...new Set((txs ?? []).map((t: { merchant_id: string }) => t.merchant_id))];
      const { data: merchants } = await fastify.supabase
        .from('merchants')
        .select('id, name')
        .in('id', merchantIds);

      const merchantNames = new Map<string, string>(
        (merchants ?? []).map((m: { id: string; name: string }) => [m.id, m.name]),
      );

      // Aggregate per merchant
      const perMerchant = new Map<string, {
        merchant_id: string;
        name: string;
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
      }>();

      for (const tx of txs ?? []) {
        const mid = tx.merchant_id as string;
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
          });
        }
        const entry = perMerchant.get(mid)!;
        const amount = Number(tx.amount ?? 0);
        const fee = Number(tx.fee ?? 0);
        const netAmount = Number(tx.net_amount ?? 0);

        entry.transaction_count += 1;
        entry.volume_collected += amount;
        entry.client_fees += fee;
        entry.avada_cost += amount * AVADA_FEE_RATE;
        entry.net_margin += amount * MARGIN_RATE;
        entry.net_amount_owed += netAmount;
      }

      // Round values
      let merchants_array = Array.from(perMerchant.values()).map((e) => ({
        ...e,
        volume_collected: Math.round(e.volume_collected * 100) / 100,
        client_fees: Math.round(e.client_fees * 100) / 100,
        avada_cost: Math.round(e.avada_cost * 100) / 100,
        net_margin: Math.round(e.net_margin * 100) / 100,
        net_amount_owed: Math.round(e.net_amount_owed * 100) / 100,
      }));

      // Sort
      const sortBy = request.query.sort ?? 'margin';
      merchants_array.sort((a, b) => {
        if (sortBy === 'volume') return b.volume_collected - a.volume_collected;
        if (sortBy === 'tx_count') return b.transaction_count - a.transaction_count;
        return b.net_margin - a.net_margin; // default: margin
      });

      // Totals
      const totals = {
        transaction_count: merchants_array.reduce((s, e) => s + e.transaction_count, 0),
        volume_collected: Math.round(merchants_array.reduce((s, e) => s + e.volume_collected, 0) * 100) / 100,
        client_fees: Math.round(merchants_array.reduce((s, e) => s + e.client_fees, 0) * 100) / 100,
        avada_cost: Math.round(merchants_array.reduce((s, e) => s + e.avada_cost, 0) * 100) / 100,
        net_margin: Math.round(merchants_array.reduce((s, e) => s + e.net_margin, 0) * 100) / 100,
        net_amount_owed: Math.round(merchants_array.reduce((s, e) => s + e.net_amount_owed, 0) * 100) / 100,
        merchant_count: merchants_array.length,
      };

      return reply.send({
        period: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        totals,
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
        .select('merchant_id, amount, fee, net_amount')
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
        .select('id, name')
        .in('id', merchantIds);

      const merchantNames = new Map<string, string>(
        (merchants ?? []).map((m: { id: string; name: string }) => [m.id, m.name]),
      );

      const perMerchant = new Map<string, {
        name: string;
        transaction_count: number;
        volume_collected: number;
        client_fees: number;
        avada_cost: number;
        net_margin: number;
        net_amount_owed: number;
      }>();

      for (const tx of txs ?? []) {
        const mid = tx.merchant_id as string;
        if (!perMerchant.has(mid)) {
          perMerchant.set(mid, {
            name: merchantNames.get(mid) ?? 'Unknown',
            transaction_count: 0,
            volume_collected: 0,
            client_fees: 0,
            avada_cost: 0,
            net_margin: 0,
            net_amount_owed: 0,
          });
        }
        const entry = perMerchant.get(mid)!;
        const amount = Number(tx.amount ?? 0);
        entry.transaction_count += 1;
        entry.volume_collected += amount;
        entry.client_fees += Number(tx.fee ?? 0);
        entry.avada_cost += amount * AVADA_FEE_RATE;
        entry.net_margin += amount * MARGIN_RATE;
        entry.net_amount_owed += Number(tx.net_amount ?? 0);
      }

      const sortBy = request.query.sort ?? 'margin';
      const rows = Array.from(perMerchant.entries()).map(([id, e]) => ({
        merchant_id: id,
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

      // Build CSV
      const headers = ['merchant_id', 'name', 'transaction_count', 'volume_collected', 'client_fees', 'avada_cost', 'net_margin', 'net_amount_owed'];
      const csvLines = [headers.join(',')];
      for (const r of rows) {
        csvLines.push([
          r.merchant_id,
          `"${r.name.replace(/"/g, '""')}"`,
          r.transaction_count,
          r.volume_collected,
          r.client_fees,
          r.avada_cost,
          r.net_margin,
          r.net_amount_owed,
        ].join(','));
      }

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="merchant-revenue-${fromDate.toISOString().slice(0,10)}-to-${toDate.toISOString().slice(0,10)}.csv"`);
      return reply.send(csvLines.join('\n'));
    },
  );
};

export default adminMerchantsRoute;
