import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { sendAdminDirectEmail } from '../../services/email';
import { logAdminAction } from '../../lib/admin-action-log';

function requireAdmin(isAdmin: boolean): boolean {
  return isAdmin;
}

interface UsersQuery {
  page: number;
  limit: number;
  kyc_level?: number;
  is_active?: boolean;
  phone?: string;
}

interface TransactionsQuery {
  page: number;
  limit: number;
  direction?: string;
  status?: string;
  operator?: string;
  date_from?: string;
  date_to?: string;
  phone?: string;
}

interface KycQuery {
  page: number;
  limit: number;
  status?: 'pending' | 'approved' | 'rejected';
}

interface AdjustBody {
  wallet_user_id: string;
  amount: number;
  reason: string;
}

interface KycRejectBody {
  note?: string;
  reviewer_note?: string;
}

const adminWalletRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/admin/wallet/avada-balance ─────────────────── */
  fastify.get('/admin/wallet/avada-balance', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    try {
      return reply.send({ balance: null, currency: 'CDF', error: 'unsupported' });
    } catch (e) {
      fastify.log.error({ err: e }, '[admin] avada balance fetch failed');
      return reply.status(500).send({ error: e instanceof Error ? e.message : 'Admin wallet balance unavailable' });
    }
  });

  /* ── GET /v1/admin/wallet/stats ──────────────────────────── */
  fastify.get('/admin/wallet/stats', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      usersRes,
      kycRes,
      depositRes,
      withdrawRes,
      p2pRes,
      todayRes,
      chartRes,
      cgltRes,
      swapsTodayRes,
    ] = await Promise.all([
      fastify.supabase.from('wallet_users').select('id', { count: 'exact', head: true }),
      fastify.supabase.from('wallet_users').select('id', { count: 'exact', head: true }).gte('kyc_level', 1),
      fastify.supabase.from('transactions').select('net_amount').eq('direction', 'collect').eq('status', 'success'),
      fastify.supabase.from('transactions').select('net_amount').eq('direction', 'payout').eq('status', 'success'),
      fastify.supabase.from('transactions').select('net_amount').eq('direction', 'p2p').eq('status', 'success'),
      fastify.supabase.from('transactions').select('id', { count: 'exact', head: true }).gte('created_at', todayIso),
      fastify.supabase
        .from('transactions')
        .select('direction, created_at')
        .gte('created_at', sevenDaysAgo)
        .order('created_at', { ascending: true }),
      fastify.supabase.from('wallet_users').select('cglt_balance'),
      fastify.supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'swap')
        .gte('created_at', todayIso),
    ]);

    const totalDeposited = (depositRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const totalWithdrawn = (withdrawRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const totalP2P = (p2pRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const totalCgltCirculating = (cgltRes.data ?? []).reduce((s, r) => s + Number(r.cglt_balance ?? 0), 0);

    // Build 7-day chart data
    const days: Record<string, { collect: number; payout: number; p2p: number; date: string }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      days[key] = { collect: 0, payout: 0, p2p: 0, date: key };
    }
    for (const tx of chartRes.data ?? []) {
      const key = (tx.created_at as string).slice(0, 10);
      if (days[key]) {
        const dir = tx.direction as string;
        if (dir === 'collect') days[key].collect++;
        else if (dir === 'payout') days[key].payout++;
        else if (dir === 'p2p') days[key].p2p++;
      }
    }

    return reply.send({
      total_users: usersRes.count ?? 0,
      kyc_verified: kycRes.count ?? 0,
      total_deposited_cdf: totalDeposited,
      total_withdrawn_cdf: totalWithdrawn,
      total_p2p_cdf: totalP2P,
      transactions_today: todayRes.count ?? 0,
      total_cglt_circulating: totalCgltCirculating,
      swaps_today: swapsTodayRes.count ?? 0,
      chart: Object.values(days),
    });
  });

  /* ── GET /v1/admin/wallet/revenue ───────────────────────── */
  fastify.get('/admin/wallet/revenue', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    function computeMetrics(rows: { amount: unknown; fee: unknown }[]) {
      const volume     = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const fraisAvada = rows.reduce((s, r) => s + Number(r.fee    ?? 0), 0);
      return {
        volume,
        frais_avada:  fraisAvada,
        frais_client: volume * Number(env.MERCHANT_FEE_RATE),
        marge_nette:  volume * (Number(env.MERCHANT_FEE_RATE) - 0.03),
        nb_tx:        rows.length,
      };
    }

    const base = () =>
      fastify.supabase
        .from('transactions')
        .select('amount, fee')
        .eq('status', 'success')
        .in('direction', ['collect', 'payout'])
        .limit(100000);

    const [todayRes, monthRes, allRes] = await Promise.all([
      base().gte('created_at', todayStart.toISOString()),
      base().gte('created_at', monthStart.toISOString()),
      base(),
    ]);

    if (todayRes.error || monthRes.error || allRes.error) {
      const err = todayRes.error ?? monthRes.error ?? allRes.error;
      fastify.log.error({ err }, '[admin] revenue query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.send({
      today: computeMetrics(todayRes.data ?? []),
      month: computeMetrics(monthRes.data ?? []),
      all:   computeMetrics(allRes.data   ?? []),
    });
  });

  /* ── GET /v1/admin/wallet/users ──────────────────────────── */
  fastify.get<{ Querystring: UsersQuery }>('/admin/wallet/users', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page:      { type: 'integer', minimum: 1, default: 1 },
          limit:     { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          kyc_level: { type: 'integer' },
          is_active: { type: 'boolean' },
          phone:     { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { page, limit, kyc_level, is_active, phone } = request.query;
    const offset = (page - 1) * limit;

    let q = fastify.supabase
      .from('wallet_users')
      .select('id, phone, full_name, balance_cdf, kyc_level, is_active, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (kyc_level !== undefined) q = q.eq('kyc_level', kyc_level);
    if (is_active !== undefined) q = q.eq('is_active', is_active);
    if (phone) q = q.ilike('phone', `%${phone}%`);

    const { data, error, count } = await q;
    if (error) {
      fastify.log.error({ err: error }, 'admin wallet users query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.send({
      data: data ?? [],
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
    });
  });

  /* ── GET /v1/admin/wallet/users/:id ─────────────────────── */
  fastify.get<{ Params: { id: string } }>('/admin/wallet/users/:id', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;

    const [userRes, txRes, ledgerRes] = await Promise.all([
      fastify.supabase
        .from('wallet_users')
        .select('id, phone, full_name, balance_cdf, kyc_level, is_active, created_at, updated_at')
        .eq('id', id)
        .maybeSingle(),
      fastify.supabase
        .from('transactions')
        .select('id, direction, amount, fee, net_amount, currency, operator, phone, status, created_at')
        .eq('wallet_user_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
      fastify.supabase
        .from('ledger_entries')
        .select('id, direction, amount, reason, created_at')
        .eq('wallet_user_id', id)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    if (userRes.error) {
      fastify.log.error({ err: userRes.error, id }, '[admin] wallet user fetch failed');
      return reply.status(500).send({ error: userRes.error.message });
    }
    if (!userRes.data) {
      return reply.status(404).send({ error: 'User not found' });
    }

    return reply.send({
      user: userRes.data,
      transactions: txRes.data ?? [],
      ledger: ledgerRes.data ?? [],
    });
  });

  /* ── POST /v1/admin/wallet/users/:id/block ───────────────── */
  fastify.post<{ Params: { id: string } }>('/admin/wallet/users/:id/block', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;
    const { error } = await fastify.supabase
      .from('wallet_users')
      .update({ is_active: false })
      .eq('id', id);

    if (error) return reply.status(500).send({ error: error.message });
    fastify.log.info({ userId: id }, 'wallet user blocked');
    void logAdminAction(fastify.supabase, 'wallet_user.block', 'wallet_user', id, {}, fastify.log);
    return reply.send({ ok: true, is_active: false });
  });

  /* ── POST /v1/admin/wallet/users/:id/unblock ─────────────── */
  fastify.post<{ Params: { id: string } }>('/admin/wallet/users/:id/unblock', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;
    const { error } = await fastify.supabase
      .from('wallet_users')
      .update({ is_active: true })
      .eq('id', id);

    if (error) return reply.status(500).send({ error: error.message });
    fastify.log.info({ userId: id }, 'wallet user unblocked');
    void logAdminAction(fastify.supabase, 'wallet_user.unblock', 'wallet_user', id, {}, fastify.log);
    return reply.send({ ok: true, is_active: true });
  });

  /* ── POST /v1/admin/wallet/users/:id/kyc/approve ─────────── */
  fastify.post<{ Params: { id: string } }>('/admin/wallet/users/:id/kyc/approve', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;
    const { data, error } = await fastify.supabase
      .from('wallet_users')
      .update({ kyc_level: 1, is_verified: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, phone, full_name, balance_cdf, kyc_level, is_active, is_verified, created_at, updated_at, kyc_submitted_at')
      .maybeSingle();

    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: 'Wallet user not found' });

    fastify.log.info({ userId: id }, '[wallet-user-kyc-approved]');
    void logAdminAction(fastify.supabase, 'wallet_user.kyc_approve', 'wallet_user', id, { kyc_level: 1 }, fastify.log);
    return reply.send({ ok: true, user: data });
  });

  /* ── POST /v1/admin/wallet/adjust ───────────────────────── */
  fastify.post<{ Body: AdjustBody }>('/admin/wallet/adjust', {
    schema: {
      body: {
        type: 'object',
        required: ['wallet_user_id', 'amount', 'reason'],
        properties: {
          wallet_user_id: { type: 'string', minLength: 1 },
          amount:         { type: 'number' },
          reason:         { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { wallet_user_id, amount, reason } = request.body;

    if (!Number.isFinite(amount) || amount === 0) {
      return reply.status(400).send({ error: 'amount must be a non-zero number' });
    }

    // Atomic update
    const { data: adjustedBalance, error: updateErr } = await fastify.supabase
      .rpc('wallet_adjust_cdf', { p_user_id: wallet_user_id, p_delta: amount });

    if (updateErr) {
      const isRejected = updateErr.message?.includes('WALLET_NOT_FOUND_OR_INSUFFICIENT_FUNDS');
      fastify.log.warn({ err: updateErr, wallet_user_id }, 'balance adjustment rejected');
      return reply.status(isRejected ? 400 : 500).send({
        error: isRejected ? 'Wallet not found or insufficient balance' : 'Balance update failed',
      });
    }
    const newBalance = Number(adjustedBalance);

    // Insert ledger entry
    await fastify.supabase.from('ledger_entries').insert({
      wallet_user_id,
      direction: amount > 0 ? 'credit' : 'debit',
      amount: Math.abs(Math.trunc(amount)),
      currency: 'CDF',
      reason: 'admin_adjustment',
      reference: `admin:${randomUUID()}`,
      note: reason,
      created_at: new Date().toISOString(),
    });

    fastify.log.info({ wallet_user_id, amount, reason, newBalance }, 'admin balance adjustment');
    void logAdminAction(fastify.supabase, 'wallet_user.balance_adjust', 'wallet_user', wallet_user_id, { amount, reason, new_balance_cdf: newBalance }, fastify.log);
    return reply.send({ ok: true, new_balance_cdf: newBalance });
  });

  /* ── GET /v1/admin/wallet/kyc ────────────────────────────── */
  fastify.get<{ Querystring: KycQuery }>('/admin/wallet/kyc', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page:   { type: 'integer', minimum: 1, default: 1 },
          limit:  { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { page, limit, status } = request.query;
    const offset = (page - 1) * limit;

    let q = fastify.supabase
      .from('kyc_submissions')
      .select(
        'id, wallet_user_id, status, doc_type, full_name, birth_date, doc_number, doc_front_url, doc_back_url, selfie_url, reviewer_note, submitted_at, reviewed_at, payguard_confidence, payguard_decision, submission_type, wallet_users(id, phone, full_name, balance_cdf, kyc_level, is_verified)',
        { count: 'exact' },
      )
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) {
      fastify.log.error({ err: error }, 'admin wallet kyc query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    const rows = await Promise.all((data ?? []).map(async (row) => {
      // Generate signed URLs for all KYC documents (selfie + ID front/back)
      const [selfieSigned, docFrontSigned, docBackSigned] = await Promise.all([
        row.selfie_url
          ? fastify.supabase.storage.from('kyc-docs').createSignedUrl(row.selfie_url, 3600)
          : Promise.resolve({ data: null, error: null }),
        row.doc_front_url
          ? fastify.supabase.storage.from('kyc-docs').createSignedUrl(row.doc_front_url, 3600)
          : Promise.resolve({ data: null, error: null }),
        row.doc_back_url
          ? fastify.supabase.storage.from('kyc-docs').createSignedUrl(row.doc_back_url, 3600)
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (selfieSigned.error) {
        fastify.log.warn({ err: selfieSigned.error, submissionId: row.id }, '[admin] kyc selfie signed url failed');
      }
      if (docFrontSigned.error) {
        fastify.log.warn({ err: docFrontSigned.error, submissionId: row.id }, '[admin] kyc doc_front signed url failed');
      }
      if (docBackSigned.error) {
        fastify.log.warn({ err: docBackSigned.error, submissionId: row.id }, '[admin] kyc doc_back signed url failed');
      }

      return {
        ...row,
        selfie_signed_url: selfieSigned.data?.signedUrl ?? null,
        doc_front_signed_url: docFrontSigned.data?.signedUrl ?? null,
        doc_back_signed_url: docBackSigned.data?.signedUrl ?? null,
      };
    }));

    return reply.send({
      data: rows,
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
    });
  });

  /* ── POST /v1/admin/wallet/kyc/:id/approve ───────────────── */
  fastify.post<{ Params: { id: string } }>('/admin/wallet/kyc/:id/approve', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;
    const { data: sub, error: fetchErr } = await fastify.supabase
      .from('kyc_submissions')
      .select('id, wallet_user_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) return reply.status(500).send({ error: fetchErr.message });
    if (!sub) return reply.status(404).send({ error: 'KYC submission not found' });

    const now = new Date().toISOString();
    const [submissionRes, userRes] = await Promise.all([
      fastify.supabase
        .from('kyc_submissions')
        .update({ status: 'approved', reviewer_note: null, reviewed_at: now, payguard_decision: 'manual_approved' })
        .eq('id', id),
      fastify.supabase
        .from('wallet_users')
        .update({ kyc_level: 1, is_verified: true })
        .eq('id', sub.wallet_user_id),
    ]);

    if (submissionRes.error) return reply.status(500).send({ error: submissionRes.error.message });
    if (userRes.error) return reply.status(500).send({ error: userRes.error.message });

    fastify.log.info({ submissionId: id, walletUserId: sub.wallet_user_id }, '[kyc-admin-approved]');
    void logAdminAction(fastify.supabase, 'wallet_kyc.approve', 'kyc_submission', id, { wallet_user_id: sub.wallet_user_id }, fastify.log);
    return reply.send({ ok: true });
  });

  /* ── POST /v1/admin/wallet/kyc/:id/reject ────────────────── */
  fastify.post<{ Params: { id: string }; Body: KycRejectBody }>('/admin/wallet/kyc/:id/reject', {
    schema: {
      body: {
        type: 'object',
        properties: {
          note: { type: 'string' },
          reviewer_note: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { id } = request.params;
    const note = request.body?.note ?? request.body?.reviewer_note ?? null;
    const { data, error } = await fastify.supabase
      .from('kyc_submissions')
      .update({
        status: 'rejected',
        reviewer_note: note,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, wallet_user_id')
      .maybeSingle();

    if (error) return reply.status(500).send({ error: error.message });
    if (!data) return reply.status(404).send({ error: 'KYC submission not found' });

    fastify.log.info({ submissionId: id, walletUserId: data.wallet_user_id }, '[kyc-admin-rejected]');
    return reply.send({ ok: true });
  });

  /* ── GET /v1/admin/wallet/transactions ───────────────────── */
  fastify.get<{ Querystring: TransactionsQuery }>('/admin/wallet/transactions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page:      { type: 'integer', minimum: 1, default: 1 },
          limit:     { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          direction: { type: 'string' },
          status:    { type: 'string' },
          operator:  { type: 'string' },
          date_from: { type: 'string' },
          date_to:   { type: 'string' },
          phone:     { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { page, limit, direction, status, operator, date_from, date_to, phone } = request.query;
    const offset = (page - 1) * limit;

    let q = fastify.supabase
      .from('transactions')
      .select(
        'id, wallet_user_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at, updated_at, swap_direction, cglt_amount, usdt_amount, blockchain_tx_hash, wallet_users(phone, full_name)',
        { count: 'exact' },
      )
      .not('wallet_user_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (direction) q = q.eq('direction', direction);
    if (status)    q = q.eq('status', status);
    if (operator)  q = q.eq('operator', operator);
    if (date_from) q = q.gte('created_at', date_from);
    if (date_to)   q = q.lte('created_at', date_to);
    if (phone)     q = q.ilike('phone', `%${phone}%`);

    const { data, error, count } = await q;
    if (error) {
      fastify.log.error({ err: error }, 'admin wallet transactions query failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    return reply.send({
      data: data ?? [],
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
    });
  });

  /* ── GET /v1/admin/wallet/transactions/export ────────────── */
  fastify.get<{ Querystring: Omit<TransactionsQuery, 'page' | 'limit'> }>(
    '/admin/wallet/transactions/export',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { direction, status, operator, date_from, date_to, phone } = request.query as TransactionsQuery;

      let q = fastify.supabase
        .from('transactions')
        .select('id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at, wallet_users(phone, full_name)')
        .not('wallet_user_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5000);

      if (direction) q = q.eq('direction', direction);
      if (status)    q = q.eq('status', status);
      if (operator)  q = q.eq('operator', operator);
      if (date_from) q = q.gte('created_at', date_from);
      if (date_to)   q = q.lte('created_at', date_to);
      if (phone)     q = q.ilike('phone', `%${phone}%`);

      const { data, error } = await q;
      if (error) return reply.status(500).send({ error: 'Export failed' });

      const rows = data ?? [];
      const header = 'date,phone_wallet,nom,type,operateur,montant,frais,net,statut,reference\n';
      const csv = rows.map((r: Record<string, unknown>) => {
        const wu = r['wallet_users'] as { phone?: string; full_name?: string } | null;
        return [
          (r['created_at'] as string)?.slice(0, 19).replace('T', ' ') ?? '',
          wu?.phone ?? r['phone'] ?? '',
          wu?.full_name ?? '',
          r['direction'] ?? '',
          r['operator'] ?? '',
          r['amount'] ?? '',
          r['fee'] ?? '',
          r['net_amount'] ?? '',
          r['status'] ?? '',
          r['reference'] ?? '',
        ].join(',');
      }).join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="wallet-transactions.csv"');
      return reply.send(header + csv);
    },
  );

  /* ── GET /v1/admin/cdp-wallets-stats ───────────────────── */
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/admin/cdp-wallets-stats',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const page  = request.query.page  ?? 1;
      const limit = request.query.limit ?? 50;
      const offset = (page - 1) * limit;

      const [totalRes, withCdpRes, usersRes] = await Promise.all([
        fastify.supabase.from('wallet_users').select('id', { count: 'exact', head: true }),
        fastify.supabase.from('wallet_users').select('id', { count: 'exact', head: true }).not('cdp_wallet_address', 'is', null),
        fastify.supabase
          .from('wallet_users')
          .select('id, phone, created_at, cdp_wallet_address', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1),
      ]);

      const totalUsers  = totalRes.count  ?? 0;
      const withCdp     = withCdpRes.count ?? 0;
      const withoutCdp  = totalUsers - withCdp;

      if (usersRes.error) {
        fastify.log.error({ err: usersRes.error }, '[admin] cdp-wallets-stats users query failed');
        return reply.status(500).send({ error: 'Internal Server Error' });
      }

      return reply.send({
        total_users: totalUsers,
        with_cdp:    withCdp,
        without_cdp: withoutCdp,
        users: usersRes.data ?? [],
        pagination: {
          page,
          limit,
          total: usersRes.count ?? 0,
          pages: Math.ceil((usersRes.count ?? 0) / limit),
        },
      });
    },
  );

  /* ── GET /v1/admin/wallet-users/:id/support-templates ──────── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/wallet-users/:id/support-templates',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const { data: user, error } = await fastify.supabase
        .from('wallet_users')
        .select('phone, full_name, email, kyc_level, is_verified, is_active')
        .eq('id', id)
        .maybeSingle();

      if (error || !user) {
        return reply.status(404).send({ error: 'Wallet user not found' });
      }

      const u = user as {
        phone: string; full_name: string | null; email: string | null;
        kyc_level: number; is_verified: boolean; is_active: boolean;
      };
      const name = u.full_name ?? u.phone;

      const templates: Array<{ label: string; subject: string; body: string }> = [];

      // KYC level 0 → encourage upgrade to level 1
      if (u.kyc_level === 0) {
        templates.push({
          label: 'Relance KYC niveau 1',
          subject: 'Vérifiez votre compte UniPay pour augmenter vos limites',
          body: `Bonjour ${name},\n\nVotre compte UniPay est actuellement au niveau KYC 0, ce qui limite vos transactions à 5 000 CDF par jour.\n\nPour augmenter vos limites (jusqu'à 500 000 CDF/jour en dépôt et 200 000 CDF/jour en retrait), soumettez votre pièce d'identité dans l'application :\n  1. Onglet Profil → Vérification KYC\n  2. Photo de votre pièce d'identité (recto/verso)\n  3. Selfie de vérification\n\nLa validation prend généralement 24 à 48 heures.\n\nCordialement,\nL'équipe UniPay Congo`,
        });
      }

      // KYC level 1 → encourage cognitive upgrade to level 2
      if (u.kyc_level === 1) {
        templates.push({
          label: 'Upgrade KYC niveau 2',
          subject: 'Débloquez toutes les fonctionnalités avec le KYC niveau 2',
          body: `Bonjour ${name},\n\nVotre compte est au niveau KYC 1. Pour accéder aux limites maximales (transactions illimitées) et à toutes les fonctionnalités UniPay, vous pouvez passer au niveau 2 en complétant le test cognitif dans l'application :\n  1. Onglet Profil → Vérification KYC → Upgrade\n  2. Complétez le test cognitif (Stroop, mémoire, etc.)\n\nCordialement,\nL'équipe UniPay Congo`,
        });
      }

      // Account suspended
      if (!u.is_active) {
        templates.push({
          label: 'Compte suspendu',
          subject: 'Votre compte UniPay est suspendu',
          body: `Bonjour ${name},\n\nVotre compte UniPay a été suspendu pour des raisons de sécurité. Pour lever la suspension, veuillez contacter notre équipe de support en répondant à cet email ou via l'application.\n\nCordialement,\nL'équipe UniPay Congo`,
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

  /* ── POST /v1/admin/wallet-users/:id/email ─────────────────── */
  fastify.post<{ Params: { id: string }; Body: { subject: string; body: string; conversation_id?: string; template_label?: string } }>(
    '/admin/wallet-users/:id/email',
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

      // Fetch wallet user — CRITICAL: use the user's own email from DB
      const { data: user, error: userError } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, full_name, email')
        .eq('id', id)
        .maybeSingle();

      if (userError || !user) {
        return reply.status(404).send({ error: 'Wallet user not found' });
      }

      const u = user as { id: string; phone: string; full_name: string | null; email: string | null };

      if (!u.email) {
        return reply.status(400).send({ error: 'This wallet user has no email address on file' });
      }

      // Find or create conversation — always scoped to THIS wallet user
      let conversationId = conversation_id;
      if (conversationId) {
        const { data: conv, error: convError } = await fastify.supabase
          .from('support_conversations')
          .select('id, wallet_user_id')
          .eq('id', conversationId)
          .eq('wallet_user_id', id) // CRITICAL: verify ownership
          .maybeSingle();

        if (convError || !conv) {
          return reply.status(404).send({ error: 'Conversation not found for this wallet user' });
        }
      } else {
        // Reuse most recent open conversation, or create new
        const { data: recentConv } = await fastify.supabase
          .from('support_conversations')
          .select('id')
          .eq('wallet_user_id', id)
          .in('status', ['open', 'escalated'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recentConv) {
          conversationId = (recentConv as { id: string }).id;
        } else {
          const { data: newConv, error: createError } = await fastify.supabase
            .from('support_conversations')
            .insert({ wallet_user_id: id, status: 'open' })
            .select('id')
            .single();

          if (createError || !newConv) {
            fastify.log.error({ err: createError, walletUserId: id }, '[admin-email] conversation creation failed');
            return reply.status(500).send({ error: 'Failed to create conversation' });
          }
          conversationId = newConv.id;
        }
      }

      // Send the email to the user's verified address
      try {
        await sendAdminDirectEmail(u.email, subject, body);
      } catch (err) {
        fastify.log.error({ err, walletUserId: id, to: u.email }, '[admin-email] email send failed');
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
        { walletUserId: id, conversationId, adminAction: 'direct_email', to: u.email, subject },
        '[admin] Direct email sent to wallet user',
      );

      return reply.send({
        ok: true,
        conversation_id: conversationId,
        sent_to: u.email,
      });
    },
  );

  /* ── GET /v1/admin/wallet-users/:id/email-history-summary ───── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/wallet-users/:id/email-history-summary',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      // Get this wallet user's conversation IDs
      const { data: convs, error: convError } = await fastify.supabase
        .from('support_conversations')
        .select('id')
        .eq('wallet_user_id', id);

      if (convError) {
        return reply.status(500).send({ error: convError.message });
      }

      if (!convs || convs.length === 0) {
        return reply.send({ summaries: [] });
      }

      const convIds = convs.map((c) => (c as { id: string }).id);

      // Query email messages with template_label, grouped by template_label
      const { data: messages, error: msgError } = await fastify.supabase
        .from('support_messages')
        .select('template_label, created_at')
        .in('conversation_id', convIds)
        .eq('channel', 'email')
        .not('template_label', 'is', null);

      if (msgError) {
        return reply.status(500).send({ error: msgError.message });
      }

      // Group by template_label
      const groups: Record<string, { count: number; last_sent_at: string }> = {};
      for (const msg of messages ?? []) {
        const m = msg as { template_label: string; created_at: string };
        const label = m.template_label;
        if (!groups[label]) {
          groups[label] = { count: 0, last_sent_at: m.created_at };
        }
        groups[label].count += 1;
        if (m.created_at > groups[label].last_sent_at) {
          groups[label].last_sent_at = m.created_at;
        }
      }

      const summaries = Object.entries(groups)
        .map(([template_label, info]) => ({ template_label, ...info }))
        .sort((a, b) => b.last_sent_at.localeCompare(a.last_sent_at));

      return reply.send({ summaries });
    },
  );

};

export default adminWalletRoute;
