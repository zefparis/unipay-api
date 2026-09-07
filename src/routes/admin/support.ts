import type { FastifyPluginAsync } from 'fastify';

function requireAdmin(isAdmin: boolean): boolean {
  return isAdmin;
}

interface ReplyBody {
  message: string;
  resolve?: boolean;
}

interface ConversationsQuery {
  status?: string;
  type?: 'merchant' | 'wallet';
  page?: number;
  limit?: number;
}

const adminSupportRoute: FastifyPluginAsync = async (fastify) => {
  /* ── GET /v1/admin/support/conversations ───────────────────── */
  fastify.get<{ Querystring: ConversationsQuery }>(
    '/admin/support/conversations',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'escalated', 'resolved'] },
            type:   { type: 'string', enum: ['merchant', 'wallet'] },
            page:   { type: 'integer', minimum: 1, default: 1 },
            limit:  { type: 'integer', minimum: 1, maximum: 100, default: 50 },
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
        .from('support_conversations')
        .select(
          'id, merchant_id, wallet_user_id, status, created_at, updated_at, merchants(name, email), wallet_users(phone, full_name, email)',
          { count: 'exact' },
        )
        .order('updated_at', { ascending: false });

      if (request.query.status) {
        q = q.eq('status', request.query.status);
      }

      // Filter by type: merchant conversations have merchant_id set,
      // wallet conversations have wallet_user_id set.
      if (request.query.type === 'merchant') {
        q = q.not('merchant_id', 'is', null);
      } else if (request.query.type === 'wallet') {
        q = q.not('wallet_user_id', 'is', null);
      }

      q = q.range(offset, offset + limit - 1);

      const { data, error, count } = await q;
      if (error) return reply.status(500).send({ error: error.message });

      // Add a discriminant `type` field and normalize the owner info
      const enriched = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const isMerchant = r.merchant_id !== null && r.merchant_id !== undefined;
        const merchant = r.merchants as Record<string, unknown> | null;
        const walletUser = r.wallet_users as Record<string, unknown> | null;
        return {
          ...r,
          type: isMerchant ? 'merchant' : 'wallet',
          owner_name: isMerchant
            ? (merchant?.name as string ?? '—')
            : (walletUser?.full_name as string ?? walletUser?.phone as string ?? '—'),
          owner_email: isMerchant
            ? (merchant?.email as string ?? null)
            : (walletUser?.email as string ?? null),
          owner_phone: isMerchant
            ? null
            : (walletUser?.phone as string ?? null),
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

  /* ── GET /v1/admin/support/conversations/:id/messages ─────── */
  fastify.get<{ Params: { id: string } }>(
    '/admin/support/conversations/:id/messages',
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;

      const [convRes, msgRes] = await Promise.all([
        fastify.supabase
          .from('support_conversations')
          .select('id, merchant_id, wallet_user_id, status, created_at, updated_at, merchants(name, email), wallet_users(phone, full_name, email)')
          .eq('id', id)
          .maybeSingle(),
        fastify.supabase
          .from('support_messages')
          .select('id, role, content, channel, subject, created_at')
          .eq('conversation_id', id)
          .order('created_at', { ascending: true }),
      ]);

      if (convRes.error || !convRes.data) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }
      if (msgRes.error) return reply.status(500).send({ error: msgRes.error.message });

      // Add discriminant type field
      const conv = convRes.data as Record<string, unknown>;
      const isMerchant = conv.merchant_id !== null && conv.merchant_id !== undefined;
      conv.type = isMerchant ? 'merchant' : 'wallet';

      return reply.send({
        conversation: conv,
        messages: msgRes.data ?? [],
      });
    },
  );

  /* ── POST /v1/admin/support/conversations/:id/reply ───────── */
  fastify.post<{ Params: { id: string }; Body: ReplyBody }>(
    '/admin/support/conversations/:id/reply',
    {
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            message:  { type: 'string', minLength: 1, maxLength: 4000 },
            resolve:  { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { id } = request.params;
      const { message, resolve } = request.body;

      // Verify conversation exists
      const { data: conv, error: convError } = await fastify.supabase
        .from('support_conversations')
        .select('id, status, merchant_id, wallet_user_id')
        .eq('id', id)
        .maybeSingle();

      if (convError || !conv) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      // Save admin message
      const { error: msgError } = await fastify.supabase
        .from('support_messages')
        .insert({
          conversation_id: id,
          role: 'admin',
          content: message,
        });

      if (msgError) {
        fastify.log.error({ err: msgError, conversationId: id }, '[admin-support] reply save failed');
        return reply.status(500).send({ error: 'Failed to save reply' });
      }

      // Update status if requested
      const convRow = conv as Record<string, unknown>;
      const currentStatus = convRow.status as string;
      const newStatus = resolve ? 'resolved' : currentStatus === 'escalated' ? 'open' : currentStatus;
      if (newStatus !== currentStatus) {
        await fastify.supabase
          .from('support_conversations')
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', id);
      }

      fastify.log.info(
        { conversationId: id, resolved: resolve, adminAction: 'support_reply' },
        '[admin-support] admin replied',
      );

      return reply.send({ ok: true, status: newStatus });
    },
  );
};

export default adminSupportRoute;
