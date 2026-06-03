import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  HMAC_SECRET: z.string().min(16),
  OPERATOR_WEBHOOK_SECRET: z.string().optional(),

  VODACASH_API_URL: z.string().url().optional(),
  VODACASH_API_KEY: z.string().optional(),

  ORANGE_API_URL: z.string().url().optional(),
  ORANGE_CLIENT_ID: z.string().optional(),
  ORANGE_CLIENT_SECRET: z.string().optional(),

  AIRTEL_API_URL: z.string().url().optional(),
  AIRTEL_CLIENT_ID: z.string().optional(),
  AIRTEL_CLIENT_SECRET: z.string().optional(),

  AFRIMONEY_API_URL: z.string().url().optional(),
  AFRIMONEY_API_KEY: z.string().optional(),

  USDT_WALLET_ADDRESS: z.string().optional(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(result.error.format());
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;

