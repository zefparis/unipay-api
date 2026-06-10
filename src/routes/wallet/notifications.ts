import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { requireWallet } from '../../utils/wallet-jwt';

const MAX_SUBS_PER_USER = 5;

const walletNotificationsRoute: FastifyPluginAsync = async (fastify) => {

  /* ── GET /v1/wallet/push/vapid-public-key — public ────────────── */
  fastify.get('/wallet/push/vapid-public-key', async (_request, reply) => {
    return reply.send({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
  });

  /* ── POST /v1/wallet/push/subscribe ────────────────────────────── */
  fastify.post<{
    Body: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string };
  }>(
    '/wallet/push/subscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint', 'keys'],
          properties: {
            endpoint:  { type: 'string', minLength: 10 },
            keys: {
              type: 'object',
              required: ['p256dh', 'auth'],
              properties: {
                p256dh: { type: 'string' },
                auth:   { type: 'string' },
              },
            },
            userAgent: { type: 'string', maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const { endpoint, keys, userAgent } = request.body;
      const userId = walletPayload.wallet_id;

      // Enforce max 5 subs per user
      const { count } = await fastify.supabase
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if ((count ?? 0) >= MAX_SUBS_PER_USER) {
        // Remove oldest to make room
        const { data: oldest } = await fastify.supabase
          .from('push_subscriptions')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .limit(1);
        if (oldest?.[0]) {
          await fastify.supabase
            .from('push_subscriptions')
            .delete()
            .eq('id', oldest[0].id);
        }
      }

      await fastify.supabase
        .from('push_subscriptions')
        .upsert(
          { user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: userAgent ?? null },
          { onConflict: 'endpoint' }
        );

      return reply.send({ ok: true });
    }
  );

  /* ── DELETE /v1/wallet/push/unsubscribe ────────────────────────── */
  fastify.delete<{ Body: { endpoint: string } }>(
    '/wallet/push/unsubscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint'],
          properties: { endpoint: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      await fastify.supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', request.body.endpoint)
        .eq('user_id', walletPayload.wallet_id);

      return reply.send({ ok: true });
    }
  );

  /* ── GET /v1/wallet/notifications ──────────────────────────────── */
  fastify.get<{ Querystring: { page?: number; limit?: number } }>(
    '/wallet/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:  { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const { page = 1, limit = 20 } = request.query;
      const from = (page - 1) * limit;
      const userId = walletPayload.wallet_id;

      const [{ data: notifications }, { count: unreadCount }] = await Promise.all([
        fastify.supabase
          .from('wallet_notifications')
          .select('id, type, title_fr, title_en, body_fr, body_en, data, read, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(from, from + limit - 1),
        fastify.supabase
          .from('wallet_notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('read', false),
      ]);

      return reply.send({ notifications: notifications ?? [], unread_count: unreadCount ?? 0 });
    }
  );

  /* ── GET /v1/wallet/notifications/unread-count ──────────────────── */
  fastify.get(
    '/wallet/notifications/unread-count',
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const { count } = await fastify.supabase
        .from('wallet_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', walletPayload.wallet_id)
        .eq('read', false);

      return reply.send({ count: count ?? 0 });
    }
  );

  /* ── POST /v1/wallet/notifications/read ─────────────────────────── */
  fastify.post<{ Body: { id?: string } }>(
    '/wallet/notifications/read',
    {
      schema: {
        body: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const userId = walletPayload.wallet_id;
      const query  = fastify.supabase
        .from('wallet_notifications')
        .update({ read: true })
        .eq('user_id', userId);

      if (request.body?.id) query.eq('id', request.body.id);

      await query;
      return reply.send({ ok: true });
    }
  );

  /* ── GET /v1/wallet/pref/notifications ──────────────────────────── */
  fastify.get(
    '/wallet/pref/notifications',
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const { data } = await fastify.supabase
        .from('wallet_users')
        .select('notif_enabled, notif_deposit, notif_transfer, notif_withdrawal, notif_system')
        .eq('id', walletPayload.wallet_id)
        .maybeSingle();

      return reply.send(data ?? {});
    }
  );

  /* ── PATCH /v1/wallet/pref/notifications ────────────────────────── */
  fastify.patch<{
    Body: {
      notif_enabled?:    boolean;
      notif_deposit?:    boolean;
      notif_transfer?:   boolean;
      notif_withdrawal?: boolean;
      notif_system?:     boolean;
    };
  }>(
    '/wallet/pref/notifications',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            notif_enabled:    { type: 'boolean' },
            notif_deposit:    { type: 'boolean' },
            notif_transfer:   { type: 'boolean' },
            notif_withdrawal: { type: 'boolean' },
            notif_system:     { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const walletPayload = requireWallet(request.headers.authorization, env.JWT_SECRET!);
      if (!walletPayload) return reply.status(401).send({ error: 'Unauthorized' });

      const allowed = ['notif_enabled', 'notif_deposit', 'notif_transfer', 'notif_withdrawal', 'notif_system'];
      const updates: Record<string, boolean> = {};
      for (const key of allowed) {
        if (key in request.body) {
          updates[key] = (request.body as Record<string, boolean>)[key];
        }
      }

      if (Object.keys(updates).length === 0) return reply.send({ ok: true });

      await fastify.supabase
        .from('wallet_users')
        .update(updates)
        .eq('id', walletPayload.wallet_id);

      return reply.send({ ok: true });
    }
  );
};

export default walletNotificationsRoute;
