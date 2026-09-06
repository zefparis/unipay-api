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
          'id, merchant_id, status, created_at, updated_at, merchants(name, email)',
          { count: 'exact' },
        )
        .order('updated_at', { ascending: false });

      if (request.query.status) {
        q = q.eq('status', request.query.status);
      }

      q = q.range(offset, offset + limit - 1);

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
          .select('id, merchant_id, status, created_at, updated_at, merchants(name, email)')
          .eq('id', id)
          .maybeSingle(),
        fastify.supabase
          .from('support_messages')
          .select('id, role, content, created_at')
          .eq('conversation_id', id)
          .order('created_at', { ascending: true }),
      ]);

      if (convRes.error || !convRes.data) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }
      if (msgRes.error) return reply.status(500).send({ error: msgRes.error.message });

      return reply.send({
        conversation: convRes.data,
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
        .select('id, status, merchant_id')
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
      const newStatus = resolve ? 'resolved' : conv.status === 'escalated' ? 'open' : conv.status;
      if (newStatus !== conv.status) {
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
