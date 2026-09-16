import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { signToken } from '../../utils/jwt';

// Dummy hash for constant-time login (M8: eliminate timing oracle).
// This hash is used when the account doesn't exist, so bcrypt.compare
// always runs — whether the account exists or not, the response time
// includes a full bcrypt comparison.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

interface LoginBody {
  email: string;
  password: string;
}

const loginRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    '/merchant/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.ip } },
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
        .select('id, name, email, password_hash, status, token_version')
        .eq('email', email)
        .maybeSingle();

      // M8: uniform 401 "Invalid credentials" in all failure cases.
      // The real reason is logged server-side for support/debugging.
      // bcrypt.compare always runs (against DUMMY_HASH if account
      // doesn't exist) to eliminate the timing oracle.
      const accountExists = !error && merchant;
      const hashToCompare = accountExists
        ? (merchant!.password_hash as string)
        : DUMMY_HASH;

      const passwordMatch = await bcrypt.compare(password, hashToCompare);

      if (!accountExists) {
        fastify.log.info({ email, reason: 'account_not_found' }, '[login] failed');
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      if (merchant!.status !== 'active') {
        fastify.log.info({ merchantId: merchant!.id, email, reason: 'inactive_account', status: merchant!.status }, '[login] failed');
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      if (!passwordMatch) {
        fastify.log.info({ merchantId: merchant!.id, email, reason: 'invalid_password' }, '[login] failed');
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      const EXPIRES_IN = 86_400; // 24 hours
      const token = signToken(
        { merchant_id: merchant.id as string, email: merchant.email as string, token_version: (merchant as { token_version: number }).token_version ?? 0 },
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
