import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';
import { signWalletToken, signRefreshToken, verifyRefreshToken, requireWallet } from '../../utils/wallet-jwt';
import { encryptPrivateKey, generateWallet } from '../../services/blockchain';
import { createUserWallet } from '../../services/cdp';
import { sendWalletWelcomeEmail, sendWalletPinChangedEmail } from '../../services/email';

interface RegisterBody {
  phone: string;
  full_name?: string;
  pin: string;
  email?: string;
  lang?: string;
}

interface LoginBody {
  phone: string;
  pin: string;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('243') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+243${digits.slice(1)}`;
  if (raw.trimStart().startsWith('+')) return raw.replace(/\s/g, '');
  return `+${digits}`;
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
            email:     { type: 'string', format: 'email', maxLength: 254 },
            lang:      { type: 'string', enum: ['fr', 'en'], default: 'fr' },
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
      const { phone, full_name, pin, email, lang } = request.body;
      const normalizedPhone = normalizePhone(phone);

      if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone)) {
        return reply.status(400).send({
          error: 'INVALID_PHONE',
          message: 'Numéro de téléphone invalide',
        });
      }

      const { data: existing } = await fastify.supabase
        .from('wallet_users')
        .select('id')
        .eq('phone', normalizedPhone)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Phone already registered', statusCode: 409 });
      }

      const pinHash = await bcrypt.hash(pin, 12);
      const blockchainWallet = generateWallet();
      const encryptedPrivateKey = encryptPrivateKey(blockchainWallet.privateKey);

      const { data: wallet, error } = await fastify.supabase
        .from('wallet_users')
        .insert({
          phone: normalizedPhone,
          full_name: full_name ?? null,
          pin_hash: pinHash,
          blockchain_address: blockchainWallet.address,
          blockchain_private_key_encrypted: encryptedPrivateKey,
          cglt_balance: 0,
          email: email ?? null,
          lang: lang ?? 'fr',
        })
        .select('id, phone, full_name')
        .single();

      if (error || !wallet) {
        fastify.log.error({ err: error, phone: normalizedPhone }, 'Wallet register failed');
        return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
      }

      fastify.log.info({ walletId: wallet.id, phone: normalizedPhone }, 'Wallet user registered');

      if (wallet && email) {
        sendWalletWelcomeEmail(email, full_name ?? '', normalizedPhone, lang ?? 'fr');
      }

      if (process.env.CDP_API_KEY_ID) {
        fastify.log.info({ walletId: wallet.id }, 'CDP wallet creation starting for userId: ' + wallet.id);
        createUserWallet(wallet.id)
          .then((cdpAddress) => {
            return fastify.supabase
              .from('wallet_users')
              .update({ cdp_wallet_address: cdpAddress })
              .eq('id', wallet.id);
          })
          .then(({ error: cdpErr }) => {
            if (cdpErr) fastify.log.error({ err: cdpErr, walletId: wallet.id }, 'CDP wallet address save failed');
            else fastify.log.info({ walletId: wallet.id }, 'CDP wallet address saved');
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            fastify.log.error({ err, walletId: wallet.id }, 'CDP wallet creation failed: ' + msg);
          });
      }

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
            phone: { type: 'string', pattern: '^\\+?[0-9\\s\\-]{8,20}$' },
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

      const { phone: rawPhone, pin } = request.body;
      const phone = rawPhone.replace(/[\s\-]/g, '');

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

      const ACCESS_TTL  = 3_600;
      const REFRESH_TTL = 2_592_000;
      const accessToken = signWalletToken(
        { wallet_id: wallet.id as string, phone: wallet.phone as string, role: 'wallet' },
        env.JWT_SECRET,
        ACCESS_TTL,
      );
      const refreshToken = signRefreshToken(
        { wallet_id: wallet.id as string },
        env.JWT_SECRET,
        REFRESH_TTL,
      );

      fastify.log.info({ walletId: wallet.id }, 'Wallet login');

      return {
        access_token:  accessToken,
        refresh_token: refreshToken,
        token_type:    'Bearer',
        expires_in:    ACCESS_TTL,
        wallet_id:     wallet.id,
        phone:         wallet.phone,
        full_name:     wallet.full_name ?? null,
      };
    },
  );

  /* ── POST /v1/wallet/auth/refresh ──────────────────────── */
  fastify.post<{ Body: { refresh_token: string } }>(
    '/wallet/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refresh_token'],
          properties: { refresh_token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      if (!env.JWT_SECRET) return reply.status(500).send({ error: 'Auth service not configured' });

      const payload = verifyRefreshToken(request.body.refresh_token, env.JWT_SECRET);
      if (!payload) return reply.status(401).send({ error: 'Invalid or expired refresh token' });

      const { data: wallet } = await fastify.supabase
        .from('wallet_users')
        .select('id, phone, is_active')
        .eq('id', payload.wallet_id)
        .maybeSingle();

      if (!wallet || !wallet.is_active) {
        return reply.status(401).send({ error: 'Account not found or suspended' });
      }

      const accessToken = signWalletToken(
        { wallet_id: wallet.id as string, phone: wallet.phone as string, role: 'wallet' },
        env.JWT_SECRET,
        3_600,
      );

      return { access_token: accessToken, expires_in: 3_600 };
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
        .select('pin_hash, email, full_name, phone, lang')
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

      const wr = walletRow as { email?: string; full_name?: string; phone?: string; lang?: string } | null;
      if (wr?.email) {
        sendWalletPinChangedEmail({ to: wr.email, name: wr.full_name ?? '', phone: wr.phone ?? '', lang: wr.lang ?? 'fr' });
      }

      return reply.send({ ok: true });
    },
  );
};

export default walletAuthRoute;
