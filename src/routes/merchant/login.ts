import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { signToken } from '../../utils/jwt';

interface LoginBody {
  email: string;
  password: string;
}

const loginRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    '/merchant/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              access_token: { type: 'string' },
              token_type: { type: 'string' },
              expires_in: { type: 'number' },
              merchant_id: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        fastify.log.error('JWT_SECRET not configured');
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const { email, password } = request.body;

      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, password_hash, status')
        .eq('email', email)
        .maybeSingle();

      if (error || !merchant) {
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      if (merchant.status !== 'active') {
        return reply.status(403).send({ error: 'Account is not active', statusCode: 403 });
      }

      const passwordMatch = await bcrypt.compare(password, merchant.password_hash as string);
      if (!passwordMatch) {
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      const EXPIRES_IN = 86_400; // 24 hours
      const token = signToken(
        { merchant_id: merchant.id as string, email: merchant.email as string },
        env.JWT_SECRET,
        EXPIRES_IN,
      );

      fastify.log.info({ merchantId: merchant.id }, 'Merchant login');

      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: EXPIRES_IN,
        merchant_id: merchant.id,
        name: merchant.name,
        email: merchant.email,
      };
    },
  );
};

export default loginRoute;
