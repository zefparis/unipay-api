import fp from 'fastify-plugin';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiKeyWithOperator } from '../types/operator';
import { env } from '../config/env';
import { safeSecretEqual, matchesAnySecret } from '../security/secret-compare';

declare module 'fastify' {
  interface FastifyRequest {
    operatorId: string;
    isAdmin: boolean;
  }
}

// Paths that skip API-key validation
const PUBLIC_PATHS = new Set(['/health', '/v1/payment/callback', '/status/operators']);

const hmacPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    const urlPath = request.url.split('?')[0];
    if (PUBLIC_PATHS.has(urlPath)) return;
    // Merchant routes use JWT auth — handled inside each route
    if (urlPath.startsWith('/v1/merchant/')) return;
    // Wallet routes use wallet JWT auth — handled inside each route
    if (urlPath.startsWith('/v1/wallet/')) return;
    if (urlPath.startsWith('/api/wallet/')) return;
    // Internal routes are authenticated via x-api-key (BRIDGE_INBOUND_API_KEY or legacy GAMING_API_KEY)
    if (urlPath.startsWith('/v1/internal/')) return;
    // Dev Expenses public report — token-protected, no admin auth
    if (urlPath.startsWith('/dev-expenses/report/')) return;

    // Admin secret bypass — accepts either ADMIN_SECRET (interactive dashboard)
    // or CRON_SERVICE_SECRET (automated cron jobs). Both grant the same admin
    // privileges but are independent secrets so each can be rotated without
    // affecting the other. Uses constant-time comparison via matchesAnySecret.
    const adminSecretHeader = request.headers['x-admin-secret'];
    if (matchesAnySecret(adminSecretHeader, [env.ADMIN_SECRET, env.CRON_SERVICE_SECRET])) {
      request.isAdmin = true;
      request.operatorId = 'admin';
      return;
    }

    const apiKey = request.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing X-API-Key header',
        statusCode: 401,
      });
    }

    // Efficient lookup: match by the first 12 chars stored as key_prefix
    const prefix = apiKey.substring(0, 12);

    const { data: keys, error } = await fastify.supabase
      .from('api_keys')
      .select('*, merchants!inner(id, name, email, status, webhook_url)')
      .eq('key_prefix', prefix)
      .eq('is_active', true);

    if (error) {
      fastify.log.error({ err: error }, 'api_keys lookup error');
      return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
    }

    if (!keys || keys.length === 0) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
    }

    // Find the matching hash — bcrypt hash is salted, so we must run
    // bcrypt.compare against every candidate returned by the prefix lookup
    // (the 12-char prefix can collide across keys, though rarely).
    let matched: ApiKeyWithOperator | null = null;
    for (const k of keys as ApiKeyWithOperator[]) {
      if (await bcrypt.compare(apiKey, k.key_hash)) {
        matched = k;
        break;
      }
    }

    if (!matched) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
    }

    if (matched.merchants.status !== 'active') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Operator account is not active',
        statusCode: 403,
      });
    }

    // Attach to request
    request.operatorId = matched.merchant_id;
    request.isAdmin = false; // merchants table has no is_admin column

    // Update last_used_at — non-blocking
    void Promise.resolve(
      fastify.supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', matched.id),
    ).catch(() => {});
  });
};

export default fp(hmacPlugin, {
  name: 'hmac-auth',
  dependencies: ['supabase-plugin'],
});
