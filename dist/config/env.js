"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().default('3000'),
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    SUPABASE_URL: zod_1.z.string().url(),
    SUPABASE_SERVICE_KEY: zod_1.z.string().min(1),
    HMAC_SECRET: zod_1.z.string().min(16),
    OPERATOR_WEBHOOK_SECRET: zod_1.z.string().optional(),
    // Unipesa aggregator (Orange, Airtel, Afrimoney)
    UNIPESA_API_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    UNIPESA_PUBLIC_ID: zod_1.z.string().optional(),
    UNIPESA_MERCHANT_ID: zod_1.z.string().optional(),
    UNIPESA_SECRET_KEY: zod_1.z.string().optional(),
    UNIPESA_CALLBACK_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    // Fixie proxy — whitelisted IP for Unipesa API calls
    FIXIE_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    // Vodacash — direct integration (coming soon)
    VODACASH_API_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    VODACASH_API_KEY: zod_1.z.string().optional(),
    // USDT on-chain
    USDT_WALLET_ADDRESS: zod_1.z.string().optional(),
    CGLT_NODE_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    CGLT_CONTRACT_ADDRESS: zod_1.z.string().optional(),
    CGLT_RESERVE_ADDRESS: zod_1.z.string().optional(),
    CGLT_MINTER_KEY: zod_1.z.string().optional(),
    USDT_ADDRESS: zod_1.z.string().optional(),
    ENCRYPTION_KEY: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().regex(/^[0-9a-fA-F]{64}$/).optional()),
    // CGLT Bridge API — required for wCGLT minting on BSC
    BRIDGE_API_URL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().url().optional()),
    BRIDGE_API_KEY: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().min(16).optional()),
    // Merchant JWT
    JWT_SECRET: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().min(32).optional()),
    // Admin secret (plain header — internal tooling only)
    ADMIN_SECRET: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().min(16).optional()),
    // Congo Gaming ↔ UniPay shared secret (CGLT betting integration)
    GAMING_API_KEY: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().min(8).optional()),
    // Fiat USD↔CDF conversion rate (manual oracle; update on Render when rate changes)
    FIAT_USD_CDF_RATE: zod_1.z.string().regex(/^\d+(\.\d+)?$/).default('2850'),
    // Stripe — diaspora card deposits
    STRIPE_SECRET_KEY: zod_1.z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().min(1).optional(),
    // Brevo transactional email
    BREVO_API_KEY: zod_1.z.string().min(1).optional(),
    BREVO_SENDER_EMAIL: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().email().optional()).default('contact@unipaycongo.com'),
    BREVO_SENDER_NAME: zod_1.z.string().default('UniPay Congo'),
    // BSC crypto deposits (Option B — one address per user)
    BSCSCAN_API_KEY: zod_1.z.string().min(1).optional(),
    // Etherscan API V2 unified key — preferred for treasury on-chain verification
    // Falls back to BSCSCAN_API_KEY when absent.
    ETHERSCAN_API_KEY: zod_1.z.string().min(1).optional(),
    UNIPAY_HD_WALLET_MNEMONIC: zod_1.z.string().min(1).optional(), // 12-word BIP-39 phrase — keep in Render Secrets
    // Transak fiat→USDT (all optional — routes disabled when API key absent)
    TRANSAK_API_KEY: zod_1.z.string().min(1).optional(),
    TRANSAK_SECRET: zod_1.z.string().min(1).optional(), // webhook HMAC secret
    TRANSAK_ENVIRONMENT: zod_1.z.enum(['STAGING', 'PRODUCTION']).default('STAGING'),
    // Public app URL (used to build Transak redirectURL)
    APP_URL: zod_1.z.string().url().default('https://app.unipaycongo.com'),
    // Web Push (VAPID) — generate with: npx web-push generate-vapid-keys
    VAPID_PUBLIC_KEY: zod_1.z.string().min(1).optional(),
    VAPID_PRIVATE_KEY: zod_1.z.string().min(1).optional(),
    VAPID_SUBJECT: zod_1.z.string().default('mailto:support@unipaycongo.com'),
    // PredictStreet server-to-server limits API
    PREDICTSTREET_BEARER_TOKEN: zod_1.z.string().min(1).optional(),
    // Binance — USDT crypto withdrawals + admin management
    BINANCE_MAIN_API_KEY: zod_1.z.string().min(1).optional(),
    BINANCE_MAIN_SECRET_KEY: zod_1.z.string().min(1).optional(),
    BINANCE_SUBACCOUNT_API_KEY: zod_1.z.string().min(1).optional(),
    BINANCE_SUBACCOUNT_SECRET_KEY: zod_1.z.string().min(1).optional(),
    // BSC hot wallet — direct USDT on-chain withdrawals
    HOT_WALLET_USDT_PRIVATE_KEY: zod_1.z.preprocess((v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : undefined), zod_1.z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
    BSC_RPC_URL: zod_1.z.string().url().default('https://bsc-dataseed.binance.org'),
    USDT_BSC_CONTRACT: zod_1.z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x55d398326f99059fF775485246999027B3197955'),
    // ADI Chain hot wallet — direct USDC on-chain withdrawals (Chain ID 36900)
    ADI_SETTLEMENT_PRIVATE_KEY: zod_1.z.preprocess((v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : undefined), zod_1.z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
    ADI_RPC_URL: zod_1.z.string().url().default('https://rpc.adifoundation.ai'),
    ADI_USDC_CONTRACT: zod_1.z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2'),
    ADI_SETTLEMENT_ADDRESS: zod_1.z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x7851E44d4A8B0939CF10EDE3922a762722437eA5'),
    // PredictStreet server-to-server HMAC secret (deposit-notify webhook)
    PREDICTSTREET_SERVER_SECRET: zod_1.z.preprocess((v) => (v === '' ? undefined : v), zod_1.z.string().min(16).optional()),
    // PredictStreet payout webhook — we POST here to request a USDC payout
    PREDICTSTREET_PAYOUT_URL: zod_1.z.preprocess((v) => { try {
        if (typeof v === 'string' && v) {
            new URL(v);
            return v;
        }
    }
    catch { /* fall */ } return undefined; }, zod_1.z.string().url().optional()),
    // Admin access — comma-separated list of allowed emails for admin routes
    ADMIN_EMAILS: zod_1.z.string().default('b.barrere@congogaming.com'),
    // Coinbase CDP — EVM server accounts (one per wallet user, Base network)
    CDP_API_KEY_ID: zod_1.z.string().min(1).optional(),
    CDP_API_KEY_SECRET: zod_1.z.string().min(1).optional(),
    CDP_WALLET_SECRET: zod_1.z.string().min(1).optional(),
});
const result = envSchema.safeParse(process.env);
if (!result.success) {
    console.error(result.error.format());
    process.exit(1);
}
exports.env = result.data;
//# sourceMappingURL=env.js.map