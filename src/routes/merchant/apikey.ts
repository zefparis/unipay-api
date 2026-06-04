import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { verifyToken } from '../../utils/jwt';

interface ApikeyBody {
  label?: string;
}

const merchantApikeyRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ApikeyBody }>(
    '/merchant/apikey',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 64 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              api_key: { type: 'string' },
              key_prefix: { type: 'string' },
              label: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const auth = request.headers.authorization;
      if (!auth?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing bearer token', statusCode: 401 });
      }
      const payload = verifyToken(auth.slice(7), env.JWT_SECRET);
      if (!payload) {
        return reply.status(401).send({ error: 'Invalid or expired token', statusCode: 401 });
      }

      const label = request.body?.label ?? 'default';

      // Deactivate any existing key with the same label for this merchant
      await fastify.supabase
        .from('api_keys')
        .update({ is_active: false })
        .eq('operator_id', payload.merchant_id)
        .eq('label', label);

      // Generate new key: upk_live_ prefix + 32 random hex chars
      const rawKey = `upk_live_${crypto.randomBytes(24).toString('hex')}`;
      const keyPrefix = rawKey.substring(0, 12);
      const keyHash = await bcrypt.hash(rawKey, 10);

      const { error } = await fastify.supabase.from('api_keys').insert({
        operator_id: payload.merchant_id,
        key_prefix: keyPrefix,
        key_hash: keyHash,
        label,
        is_active: true,
      });

      if (error) {
        fastify.log.error({ err: error, merchantId: payload.merchant_id }, 'API key generation failed');
        return reply.status(500).send({ error: 'Key generation failed', statusCode: 500 });
      }

      fastify.log.info({ merchantId: payload.merchant_id, label }, 'API key generated');

      return reply.status(201).send({
        api_key: rawKey,
        key_prefix: keyPrefix,
        label,
        note: 'Store this key securely — it will not be shown again.',
      });
    },
  );
};

export default merchantApikeyRoute;
