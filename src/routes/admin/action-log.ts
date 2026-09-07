import type { FastifyPluginAsync } from 'fastify';

function requireAdmin(isAdmin: boolean): boolean {
  return isAdmin;
}

interface ActionLogQuery {
  page: number;
  limit: number;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
}

const actionLogRoute: FastifyPluginAsync = async (fastify) => {
  /* ── GET /v1/admin/action-log ───────────────────────────────── */
  fastify.get<{ Querystring: ActionLogQuery }>(
    '/admin/action-log',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:          { type: 'integer', minimum: 1, default: 1 },
            limit:         { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            action:        { type: 'string', maxLength: 128 },
            resource_type: { type: 'string', maxLength: 64 },
            resource_id:   { type: 'string', format: 'uuid' },
            from:          { type: 'string', format: 'date-time' },
            to:            { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAdmin(request.isAdmin)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { page, limit, action, resource_type, resource_id, from, to } = request.query;
      const offset = (page - 1) * limit;

      let query = fastify.supabase
        .from('admin_action_log')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (action)        query = query.eq('action', action);
      if (resource_type) query = query.eq('resource_type', resource_type);
      if (resource_id)   query = query.eq('resource_id', resource_id);
      if (from)          query = query.gte('created_at', from);
      if (to)            query = query.lte('created_at', to);

      const { data, error, count } = await query;

      if (error) {
        fastify.log.error({ err: error }, '[admin/action-log] query failed');
        return reply.status(500).send({ error: error.message });
      }

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
};

export default actionLogRoute;
