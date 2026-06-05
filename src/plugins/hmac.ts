import fp from 'fastify-plugin';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiKeyWithOperator } from '../types/operator';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyRequest {
    operatorId: string;
    isAdmin: boolean;
  }
}

// Paths that skip API-key validation
const PUBLIC_PATHS = new Set(['/health', '/v1/payment/callback']);

const hmacPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    const urlPath = request.url.split('?')[0];
    if (PUBLIC_PATHS.has(urlPath)) return;
    // Merchant routes use JWT auth — handled inside each route
    if (urlPath.startsWith('/v1/merchant/')) return;

    // Admin secret bypass — avoids API key requirement for admin tooling
    const adminSecretHeader = request.headers['x-admin-secret'];
    if (env.ADMIN_SECRET && adminSecretHeader === env.ADMIN_SECRET) {
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
      .select('*, operators!inner(id, name, email, status, is_admin, webhook_url)')
      .eq('key_prefix', prefix)
      .eq('is_active', true);

    if (error) {
      fastify.log.error({ err: error }, 'api_keys lookup error');
      return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
    }

    if (!keys || keys.length === 0) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
    }

    // Find the matching hash (usually 1 candidate)
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

    if (matched.operators.status !== 'active') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Operator account is not active',
        statusCode: 403,
      });
    }

    // Attach to request
    request.operatorId = matched.operator_id;
    request.isAdmin = matched.operators.is_admin;

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
