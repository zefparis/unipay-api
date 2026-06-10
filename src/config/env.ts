import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  HMAC_SECRET: z.string().min(16),
  OPERATOR_WEBHOOK_SECRET: z.string().optional(),

  // Unipesa aggregator (Orange, Airtel, Afrimoney)
  UNIPESA_API_URL: z.string().url().optional(),
  UNIPESA_PUBLIC_ID: z.string().optional(),
  UNIPESA_MERCHANT_ID: z.string().optional(),
  UNIPESA_SECRET_KEY: z.string().optional(),
  UNIPESA_CALLBACK_URL: z.string().url().optional(),

  // Fixie proxy — whitelisted IP for Unipesa API calls
  FIXIE_URL: z.string().url().optional(),

  // Vodacash — direct integration (coming soon)
  VODACASH_API_URL: z.string().url().optional(),
  VODACASH_API_KEY: z.string().optional(),

  // USDT on-chain
  USDT_WALLET_ADDRESS: z.string().optional(),
  CGLT_NODE_URL: z.string().url().optional(),
  CGLT_CONTRACT_ADDRESS: z.string().optional(),
  CGLT_RESERVE_ADDRESS: z.string().optional(),
  CGLT_MINTER_KEY: z.string().optional(),
  USDT_ADDRESS: z.string().optional(),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

  // Merchant JWT
  JWT_SECRET: z.string().min(32).optional(),

  // Admin secret (plain header — internal tooling only)
  ADMIN_SECRET: z.string().min(16).optional(),

  // Congo Gaming ↔ UniPay shared secret (CGLT betting integration)
  GAMING_API_KEY: z.string().min(8).optional(),

  // Fiat USD↔CDF conversion rate (manual oracle; update on Render when rate changes)
  FIAT_USD_CDF_RATE: z.string().regex(/^\d+(\.\d+)?$/).default('2850'),

  // Stripe — diaspora card deposits
  STRIPE_SECRET_KEY:    z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Brevo transactional email
  BREVO_API_KEY:      z.string().min(1).optional(),
  BREVO_SENDER_EMAIL: z.string().email().default('contact@unipaycongo.com'),
  BREVO_SENDER_NAME:  z.string().default('UniPay Congo'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error(result.error.format());
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;

