import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';

interface RegisterBody {
  name: string;
  email: string;
  password: string;
  webhook_url?: string;
}

const registerRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RegisterBody }>(
    '/merchant/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email', 'password'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 128 },
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            webhook_url: { type: 'string', format: 'uri' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              merchant_id: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, email, password, webhook_url } = request.body;

      // Check if email already exists
      const { data: existing } = await fastify.supabase
        .from('operators')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Email already registered', statusCode: 409 });
      }

      const merchantId = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(password, 12);

      const { error } = await fastify.supabase.from('operators').insert({
        id: merchantId,
        name,
        email,
        password_hash: passwordHash,
        webhook_url: webhook_url ?? null,
        status: 'active',
        balance_cdf: 0,
        is_admin: false,
      });

      if (error) {
        fastify.log.error({ err: error, email }, 'Merchant registration failed');
        return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
      }

      fastify.log.info({ merchantId, email }, 'Merchant registered');

      return reply.status(201).send({
        merchant_id: merchantId,
        name,
        email,
        status: 'active',
      });
    },
  );
};

export default registerRoute;
