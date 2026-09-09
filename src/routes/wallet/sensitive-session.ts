import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { requireActiveWallet } from '../../lib/wallet-auth.js';

/**
 * Wallet sensitive-session management — local to unipay-api.
 *
 * Replaces the previous dependency on hybrid-vector-api's
 * pulseguard_sensitive_sessions table for the security decision. The
 * invalidation trigger (user leaves the app > tolerance_ms) is unchanged;
 * re-verification is now a PIN check against wallet_users.pin_hash (bcrypt),
 * the same pattern used by /wallet/auth/change-pin.
 *
 * Endpoints:
 *   POST /v1/wallet/session/visibility   — blur/focus events
 *   GET  /v1/wallet/session/status        — check session status
 *   POST /v1/wallet/session/reactivate    — verify PIN, reset to active
 *
 * Rate limiting on reactivate: 5 attempts per minute per wallet_id via
 * @fastify/rate-limit (same pattern as /wallet/login and /wallet/register).
 */

const DEFAULT_TOLERANCE_MS = 30_000;

interface VisibilityBody {
  sessionId: string;
  event: 'blur' | 'focus';
}

interface ReactivateBody {
  sessionId: string;
  pin: string;
}

const sensitiveSessionRoute: FastifyPluginAsync = async (fastify) => {
  // ── POST /v1/wallet/session/visibility ─────────────────────────────
  fastify.post<{ Body: VisibilityBody }>(
    '/wallet/session/visibility',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'event'],
          properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 256 },
            event: { type: 'string', enum: ['blur', 'focus'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const walletId = auth.payload.wallet_id;
      const { sessionId, event } = request.body;

      if (event === 'blur') {
        // Suspend any existing active session for this (wallet_id, session_id).
        // Upsert: if no row exists, create one as 'suspended'; if an active
        // row exists, suspend it. The 30s tolerance is enforced lazily on
        // status reads (see GET /status below) and on reactivate, so we don't
        // need an in-memory timer — the DB is the source of truth.
        const now = new Date().toISOString();
        const { data: existing } = await fastify.supabase
          .from('wallet_sensitive_sessions')
          .select('id, status')
          .eq('wallet_id', walletId)
          .eq('session_id', sessionId)
          .in('status', ['active', 'suspended'])
          .maybeSingle();

        if (existing) {
          if (existing.status === 'active') {
            await fastify.supabase
              .from('wallet_sensitive_sessions')
              .update({ status: 'suspended', suspended_at: now, blurred_at: now, updated_at: now })
              .eq('id', existing.id);
          }
          // If already suspended, just refresh blurred_at so the tolerance
          // window restarts from this blur event.
          else {
            await fastify.supabase
              .from('wallet_sensitive_sessions')
              .update({ blurred_at: now, updated_at: now })
              .eq('id', existing.id);
          }
          return reply.send({ ok: true, status: 'suspended' });
        }

        // No existing row — create a new suspended session.
        const { error: insertErr } = await fastify.supabase
          .from('wallet_sensitive_sessions')
          .insert({
            wallet_id: walletId,
            session_id: sessionId,
            status: 'suspended',
            suspended_at: now,
            blurred_at: now,
            tolerance_ms: DEFAULT_TOLERANCE_MS,
          });

        if (insertErr) {
          fastify.log.error({ err: insertErr, walletId }, 'sensitive session blur insert failed');
          return reply.status(500).send({ error: 'DB error', statusCode: 500 });
        }
        return reply.send({ ok: true, status: 'suspended' });
      }

      // event === 'focus'
      // Restore any suspended session for this (wallet_id, session_id) to active,
      // but only if the tolerance has not expired. If it has expired, mark it
      // invalidated — the client will then need to re-verify via PIN.
      const { data: session } = await fastify.supabase
        .from('wallet_sensitive_sessions')
        .select('id, status, suspended_at, tolerance_ms')
        .eq('wallet_id', walletId)
        .eq('session_id', sessionId)
        .in('status', ['active', 'suspended'])
        .maybeSingle();

      if (!session) {
        // No session record — treat as active (no tracking started yet).
        return reply.send({ ok: true, status: 'active' });
      }

      if (session.status === 'active') {
        return reply.send({ ok: true, status: 'active' });
      }

      // status === 'suspended' — check tolerance
      const toleranceMs = session.tolerance_ms || DEFAULT_TOLERANCE_MS;
      const suspendedAt = session.suspended_at ? new Date(session.suspended_at).getTime() : 0;
      const elapsed = Date.now() - suspendedAt;

      if (elapsed >= toleranceMs) {
        // Tolerance expired — invalidate.
        const now = new Date().toISOString();
        await fastify.supabase
          .from('wallet_sensitive_sessions')
          .update({ status: 'invalidated', invalidated_at: now, updated_at: now })
          .eq('id', session.id);
        return reply.send({ ok: true, status: 'invalidated' });
      }

      // Within tolerance — restore to active.
      const now = new Date().toISOString();
      await fastify.supabase
        .from('wallet_sensitive_sessions')
        .update({ status: 'active', suspended_at: null, blurred_at: null, updated_at: now })
        .eq('id', session.id);
      return reply.send({ ok: true, status: 'active' });
    },
  );

  // ── GET /v1/wallet/session/status ──────────────────────────────────
  fastify.get<{ Querystring: { sessionId?: string } }>(
    '/wallet/session/status',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const walletId = auth.payload.wallet_id;
      const sessionId = request.query.sessionId;
      if (!sessionId) {
        return reply.status(400).send({ error: 'sessionId is required', statusCode: 400 });
      }

      const { data: session } = await fastify.supabase
        .from('wallet_sensitive_sessions')
        .select('id, status, suspended_at, tolerance_ms')
        .eq('wallet_id', walletId)
        .eq('session_id', sessionId)
        .in('status', ['active', 'suspended'])
        .maybeSingle();

      if (!session) {
        // No active/suspended row — either never tracked or already invalidated.
        // Check for an invalidated row to report the correct status.
        const { data: invalidated } = await fastify.supabase
          .from('wallet_sensitive_sessions')
          .select('id')
          .eq('wallet_id', walletId)
          .eq('session_id', sessionId)
          .eq('status', 'invalidated')
          .order('invalidated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (invalidated) {
          return reply.send({ ok: true, status: 'invalidated' });
        }
        // No record at all — active by default.
        return reply.send({ ok: true, status: 'active' });
      }

      if (session.status === 'active') {
        return reply.send({ ok: true, status: 'active' });
      }

      // status === 'suspended' — lazy reconciliation: if tolerance expired,
      // invalidate now (handles server restart where no in-memory timer ran).
      const toleranceMs = session.tolerance_ms || DEFAULT_TOLERANCE_MS;
      const suspendedAt = session.suspended_at ? new Date(session.suspended_at).getTime() : 0;
      const elapsed = Date.now() - suspendedAt;

      if (elapsed >= toleranceMs) {
        const now = new Date().toISOString();
        await fastify.supabase
          .from('wallet_sensitive_sessions')
          .update({ status: 'invalidated', invalidated_at: now, updated_at: now })
          .eq('id', session.id);
        return reply.send({ ok: true, status: 'invalidated' });
      }

      return reply.send({ ok: true, status: 'suspended' });
    },
  );

  // ── POST /v1/wallet/session/reactivate ──────────────────────────────
  // Verify the wallet PIN against pin_hash (bcrypt) and, if valid, reset the
  // session to 'active'. Rate-limited to 5 attempts per minute per wallet_id
  // to prevent brute-force (same limit as /wallet/login).
  fastify.post<{ Body: ReactivateBody }>(
    '/wallet/session/reactivate',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req: { headers: Record<string, string | string[] | undefined> }) => {
        // Rate limit per wallet_id (extracted from JWT) rather than per IP,
        // so a distributed brute-force against one account is still throttled.
        const auth = req.headers.authorization;
        if (typeof auth !== 'string') return 'no-auth';
        // We can't verify the JWT here without env.JWT_SECRET, but we can
        // extract the wallet_id from the token payload without verification
        // for rate-limit keying only — the actual verification happens in
        // requireActiveWallet below.
        try {
          const token = auth.replace(/^Bearer\s+/i, '');
          const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
          return `wallet:${payload.wallet_id ?? 'unknown'}`;
        } catch {
          return 'malformed';
        }
      } } },
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'pin'],
          properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 256 },
            pin: { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveWallet(request, fastify.supabase, 'id, phone, is_active, kyc_level, pin_hash');
      if (!auth.ok) return reply.status(auth.status).send(auth.error);
      const walletId = auth.payload.wallet_id;
      const { sessionId, pin } = request.body;

      // Fetch the session — must be invalidated to be reactivated.
      const { data: session } = await fastify.supabase
        .from('wallet_sensitive_sessions')
        .select('id, status')
        .eq('wallet_id', walletId)
        .eq('session_id', sessionId)
        .eq('status', 'invalidated')
        .order('invalidated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!session) {
        // No invalidated session — nothing to reactivate. Check if there's
        // an active/suspended one (in which case reactivation is not needed).
        const { data: active } = await fastify.supabase
          .from('wallet_sensitive_sessions')
          .select('id, status')
          .eq('wallet_id', walletId)
          .eq('session_id', sessionId)
          .in('status', ['active', 'suspended'])
          .maybeSingle();

        if (active) {
          return reply.status(409).send({
            error: 'Session is not invalidated',
            statusCode: 409,
          });
        }
        return reply.status(404).send({
          error: 'No invalidated session found for this sessionId',
          statusCode: 404,
        });
      }

      // Verify the PIN against pin_hash (bcrypt) — same pattern as change-pin.
      const pinHash = auth.wallet.pin_hash as string | null;
      if (!pinHash) {
        fastify.log.error({ walletId }, 'reactivate: wallet has no pin_hash');
        return reply.status(500).send({ error: 'PIN not configured for this wallet', statusCode: 500 });
      }

      const pinMatch = await bcrypt.compare(pin, pinHash);
      if (!pinMatch) {
        return reply.status(401).send({ error: 'Invalid PIN', statusCode: 401 });
      }

      // PIN is valid — reset the session to active.
      const now = new Date().toISOString();
      const { error: updateErr } = await fastify.supabase
        .from('wallet_sensitive_sessions')
        .update({
          status: 'active',
          suspended_at: null,
          invalidated_at: null,
          blurred_at: null,
          updated_at: now,
        })
        .eq('id', session.id)
        .eq('status', 'invalidated');

      if (updateErr) {
        fastify.log.error({ err: updateErr, walletId }, 'reactivate: session reset failed');
        return reply.status(500).send({ error: 'Failed to reactivate session', statusCode: 500 });
      }

      fastify.log.info({ walletId, sessionId }, 'sensitive session reactivated via PIN');
      return reply.send({ ok: true, status: 'active' });
    },
  );
};

export default sensitiveSessionRoute;
