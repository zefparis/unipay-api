import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';

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

interface AdjustBody {
  wallet_user_id: string;
  amount: number;
  reason: string;
}

const adminWalletRoute: FastifyPluginAsync = async (fastify) => {

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
    ]);

    const totalDeposited = (depositRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const totalWithdrawn = (withdrawRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);
    const totalP2P = (p2pRes.data ?? []).reduce((s, r) => s + Number(r.net_amount ?? 0), 0);

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
      chart: Object.values(days),
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
        .select('id, phone, full_name, email, balance_cdf, kyc_level, is_active, created_at, updated_at, kyc_submitted_at, kyc_approved_at, kyc_document_urls')
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

    if (userRes.error || !userRes.data) {
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
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) return reply.status(500).send({ error: error.message });
    fastify.log.info({ userId: id }, 'wallet user blocked');
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
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) return reply.status(500).send({ error: error.message });
    fastify.log.info({ userId: id }, 'wallet user unblocked');
    return reply.send({ ok: true, is_active: true });
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

    // Fetch current balance
    const { data: user, error: fetchErr } = await fastify.supabase
      .from('wallet_users')
      .select('id, balance_cdf, is_active')
      .eq('id', wallet_user_id)
      .maybeSingle();

    if (fetchErr || !user) {
      return reply.status(404).send({ error: 'Wallet user not found' });
    }

    const currentBalance = Number(user.balance_cdf ?? 0);
    if (amount < 0 && currentBalance + amount < 0) {
      return reply.status(400).send({ error: 'Insufficient balance for debit adjustment' });
    }

    const newBalance = currentBalance + amount;

    // Atomic update
    const { error: updateErr } = await fastify.supabase
      .from('wallet_users')
      .update({ balance_cdf: newBalance, updated_at: new Date().toISOString() })
      .eq('id', wallet_user_id);

    if (updateErr) {
      fastify.log.error({ err: updateErr, wallet_user_id }, 'balance adjustment failed');
      return reply.status(500).send({ error: 'Balance update failed' });
    }

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
    return reply.send({ ok: true, new_balance_cdf: newBalance });
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
        'id, wallet_user_id, direction, operator, phone, amount, fee, net_amount, currency, status, reference, created_at, updated_at, wallet_users(phone, full_name)',
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

  /* ── GET /v1/admin/merchants ─────────────────────────────── */
  fastify.get('/admin/merchants', async (request, reply) => {
    if (!requireAdmin(request.isAdmin)) {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const { data, error } = await fastify.supabase
      .from('merchants')
      .select('id, name, email, mode, kyc_status, status, created_at')
      .order('created_at', { ascending: false });

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ data: data ?? [] });
  });

  /* ── POST /v1/admin/merchants/:id/mode ───────────────────── */
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
};

export default adminWalletRoute;
