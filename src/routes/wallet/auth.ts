import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { signWalletToken } from '../../utils/wallet-jwt';

interface RegisterBody {
  phone: string;
  full_name?: string;
  pin: string;
}

interface LoginBody {
  phone: string;
  pin: string;
}

const walletAuthRoute: FastifyPluginAsync = async (fastify) => {

  /* ── POST /v1/wallet/register ───────────────────────────── */
  fastify.post<{ Body: RegisterBody }>(
    '/wallet/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'pin'],
          properties: {
            phone:     { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            full_name: { type: 'string', minLength: 2, maxLength: 100 },
            pin:       { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              wallet_id:  { type: 'string' },
              phone:      { type: 'string' },
              full_name:  { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { phone, full_name, pin } = request.body;

      const { data: existing } = await fastify.supabase
        .from('wallet_users')
        .select('id')
        .eq('phone', phone)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Phone already registered', statusCode: 409 });
      }

      const pinHash = await bcrypt.hash(pin, 12);

      const { data: wallet, error } = await fastify.supabase
        .from('wallet_users')
        .insert({ phone, full_name: full_name ?? null, pin_hash: pinHash })
        .select('id, phone, full_name')
        .single();

      if (error || !wallet) {
        fastify.log.error({ err: error, phone }, 'Wallet register failed');
        return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
      }

      fastify.log.info({ walletId: wallet.id, phone }, 'Wallet user registered');

      return reply.status(201).send({
        wallet_id: wallet.id,
        phone: wallet.phone,
        full_name: wallet.full_name ?? null,
      });
    },
  );

  /* ── POST /v1/wallet/login ──────────────────────────────── */
  fastify.post<{ Body: LoginBody }>(
    '/wallet/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'pin'],
          properties: {
            phone: { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
            pin:   { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              access_token: { type: 'string' },
              token_type:   { type: 'string' },
              expires_in:   { type: 'number' },
              wallet_id:    { type: 'string' },
              phone:        { type: 'string' },
              full_name:    { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) {
        return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
      }

      const { phone, pin } = request.body;

      const { data: wallet, error } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, full_name, pin_hash, is_active')
        .eq('phone', phone)
        .maybeSingle();

      if (error || !wallet) {
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      if (!wallet.is_active) {
        return reply.status(403).send({ error: 'Account is suspended', statusCode: 403 });
      }

      const pinMatch = await bcrypt.compare(pin, wallet.pin_hash as string);
      if (!pinMatch) {
        return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
      }

      const EXPIRES_IN = 86_400;
      const token = signWalletToken(
        { wallet_id: wallet.id as string, phone: wallet.phone as string, role: 'wallet' },
        env.JWT_SECRET,
        EXPIRES_IN,
      );

      fastify.log.info({ walletId: wallet.id }, 'Wallet login');

      return {
        access_token: token,
        token_type:   'Bearer',
        expires_in:   EXPIRES_IN,
        wallet_id:    wallet.id,
        phone:        wallet.phone,
        full_name:    wallet.full_name ?? null,
      };
    },
  );
};

export default walletAuthRoute;
