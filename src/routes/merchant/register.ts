import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { sendWelcomeEmail } from '../../services/email.js';

const OPERATORS = ['orange', 'airtel', 'afrimoney', 'vodacash'] as const;

interface RegisterBody {
  name: string;
  email: string;
  password: string;
  phone?: string;
  country?: string;
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
            name:     { type: 'string', minLength: 2, maxLength: 128 },
            email:    { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            phone:    { type: 'string', maxLength: 32 },
            country:  { type: 'string', maxLength: 8 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              merchant_id: { type: 'string' },
              name:        { type: 'string' },
              email:       { type: 'string' },
              api_key:     { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, email, password, phone, country } = request.body;

      // 1. Check email uniqueness in merchants table
      const { data: existing } = await fastify.supabase
        .from('merchants')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Email already registered', statusCode: 409 });
      }

      // 2. Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // 3. Insert merchant
      const { data: merchant, error: merchantError } = await fastify.supabase
        .from('merchants')
        .insert({
          name,
          email,
          password_hash: passwordHash,
          phone:   phone   ?? null,
          country: country ?? 'CD',
          status:  'active',
        })
        .select('id')
        .single();

      if (merchantError || !merchant) {
        fastify.log.error({ err: merchantError, email }, 'Merchant insert failed');
        return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
      }

      const merchantId: string = merchant.id as string;

      // 4. Create one operators row per operator
      const operatorRows = OPERATORS.map((op) => ({
        merchant_id:  merchantId,
        operator:     op,
        balance_cdf:  0,
        status:       'active',
      }));

      const { error: opError } = await fastify.supabase
        .from('operators')
        .insert(operatorRows);

      if (opError) {
        fastify.log.error({ err: opError, merchantId }, 'Operator rows creation failed');
      }

      // 5. Generate API key: plaintext = "up_<32 random hex>", store bcrypt hash
      const rawKey    = `up_${crypto.randomBytes(16).toString('hex')}`;
      const keyHash   = await bcrypt.hash(rawKey, 10);
      const keyPrefix = rawKey.slice(0, 8);

      const { error: keyError } = await fastify.supabase
        .from('api_keys')
        .insert({
          merchant_id:  merchantId,
          key_hash:     keyHash,
          key_prefix:   keyPrefix,
          label:        'default',
          is_active:    true,
        });

      if (keyError) {
        fastify.log.error({ err: keyError, merchantId }, 'API key insert failed');
        return reply.status(500).send({ error: 'API key generation failed', statusCode: 500 });
      }

      fastify.log.info({ merchantId, email }, 'Merchant registered');

      // Fire welcome email — non-blocking, errors are logged but don't fail the request
      sendWelcomeEmail(email, name, rawKey).catch((err: unknown) => {
        fastify.log.error({ err, email }, 'Welcome email failed');
      });

      return reply.status(201).send({
        merchant_id: merchantId,
        name,
        email,
        api_key: rawKey,
      });
    },
  );
};

export default registerRoute;
