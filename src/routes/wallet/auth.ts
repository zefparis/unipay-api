import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { signWalletToken, requireWallet } from '../../utils/wallet-jwt';

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

  /* ── POST /v1/wallet/auth/change-pin ────────────────────── */
  fastify.post<{ Body: { current_pin: string; new_pin: string; confirm_pin: string } }>(
    '/wallet/auth/change-pin',
    {
      schema: {
        body: {
          type: 'object',
          required: ['current_pin', 'new_pin', 'confirm_pin'],
          properties: {
            current_pin: { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
            new_pin:     { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
            confirm_pin: { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
          },
        },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });

      const wp = requireWallet(request.headers.authorization, env.JWT_SECRET);
      if (!wp) return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });

      const { current_pin, new_pin, confirm_pin } = request.body;

      if (new_pin !== confirm_pin) {
        return reply.status(400).send({ error: 'New PIN and confirmation do not match', statusCode: 400 });
      }

      const { data: walletRow, error: fetchErr } = await fastify.supabase
        .from('wallet_users')
        .select('pin_hash')
        .eq('id', wp.wallet_id)
        .maybeSingle();

      if (fetchErr || !walletRow) {
        return reply.status(404).send({ error: 'Wallet not found', statusCode: 404 });
      }

      const match = await bcrypt.compare(current_pin, walletRow.pin_hash as string);
      if (!match) {
        return reply.status(401).send({ error: 'Current PIN is incorrect', statusCode: 401 });
      }

      const newHash = await bcrypt.hash(new_pin, 12);
      const { error: updateErr } = await fastify.supabase
        .from('wallet_users')
        .update({ pin_hash: newHash })
        .eq('id', wp.wallet_id);

      if (updateErr) {
        fastify.log.error({ err: updateErr, walletId: wp.wallet_id }, 'PIN change failed');
        return reply.status(500).send({ error: 'PIN change failed', statusCode: 500 });
      }

      fastify.log.info({ walletId: wp.wallet_id }, 'PIN changed');
      return reply.send({ ok: true });
    },
  );
};

export default walletAuthRoute;
