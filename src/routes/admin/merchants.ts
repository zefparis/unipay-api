import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

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

      // Enrich with transaction stats + API key status
      const merchantIds = (merchants ?? []).map((m) => (m as { id: string }).id);
      let txStatsMap: Record<string, { tx_count: number; total_volume: number; last_tx_at: string | null }> = {};
      let keyStatusMap: Record<string, { has_active_key: boolean; key_count: number }> = {};

      if (merchantIds.length > 0) {
        const [txStatsRes, keyStatsRes] = await Promise.all([
          fastify.supabase
            .from('transactions')
            .select('merchant_id, net_amount, created_at')
            .in('merchant_id', merchantIds)
            .eq('status', 'success'),
          fastify.supabase
            .from('api_keys')
            .select('merchant_id, is_active')
            .in('merchant_id', merchantIds),
        ]);

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
        return {
          ...m,
          transaction_count: stats.tx_count,
          total_volume: stats.total_volume,
          last_transaction_at: stats.last_tx_at,
          api_key_status: keys.key_count === 0 ? 'none' : keys.has_active_key ? 'active' : 'inactive',
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
};

export default adminMerchantsRoute;
