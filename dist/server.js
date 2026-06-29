"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("./config/env");
const cors_1 = __importDefault(require("./plugins/cors"));
const supabase_1 = __importDefault(require("./plugins/supabase"));
const hmac_1 = __importDefault(require("./plugins/hmac"));
const initiate_1 = __importDefault(require("./routes/payment/initiate"));
const callback_1 = __importDefault(require("./routes/payment/callback"));
const status_1 = __importDefault(require("./routes/payment/status"));
const auth_1 = __importDefault(require("./routes/operator/auth"));
const balance_1 = __importDefault(require("./routes/operator/balance"));
const transactions_1 = __importDefault(require("./routes/admin/transactions"));
const register_1 = __importDefault(require("./routes/merchant/register"));
const login_1 = __importDefault(require("./routes/merchant/login"));
const transactions_2 = __importDefault(require("./routes/merchant/transactions"));
const balance_2 = __importDefault(require("./routes/merchant/balance"));
const apikey_1 = __importDefault(require("./routes/merchant/apikey"));
const webhook_1 = __importDefault(require("./routes/merchant/webhook"));
const kyc_1 = __importDefault(require("./routes/merchant/kyc"));
const mode_1 = __importDefault(require("./routes/merchant/mode"));
const kyc_2 = __importDefault(require("./routes/admin/kyc"));
const auth_2 = __importDefault(require("./routes/wallet/auth"));
const balance_3 = __importDefault(require("./routes/wallet/balance"));
const deposit_1 = __importDefault(require("./routes/wallet/deposit"));
const withdraw_1 = __importDefault(require("./routes/wallet/withdraw"));
const swap_1 = __importDefault(require("./routes/wallet/swap"));
const cglt_gaming_1 = __importDefault(require("./routes/wallet/cglt-gaming"));
const unipesa_1 = __importDefault(require("./routes/wallet/unipesa"));
const transactions_3 = __importDefault(require("./routes/wallet/transactions"));
const p2p_1 = __importDefault(require("./routes/wallet/p2p"));
const profile_1 = __importDefault(require("./routes/wallet/profile"));
const kyc_3 = __importDefault(require("./routes/wallet/kyc"));
const wallet_reconcile_1 = __importDefault(require("./routes/admin/wallet-reconcile"));
const wallet_inspect_1 = __importDefault(require("./routes/admin/wallet-inspect"));
const wallet_1 = __importDefault(require("./routes/admin/wallet"));
const wcglt_swap_1 = __importDefault(require("./routes/wallet/wcglt-swap"));
const internal_1 = __importDefault(require("./routes/wallet/internal"));
const stripe_1 = __importDefault(require("./routes/wallet/stripe"));
const transak_1 = __importDefault(require("./routes/wallet/transak"));
const crypto_deposit_1 = __importDefault(require("./routes/wallet/crypto-deposit"));
const crypto_withdraw_1 = __importDefault(require("./routes/wallet/crypto-withdraw"));
const binance_1 = __importDefault(require("./routes/admin/binance"));
const hotwallet_1 = __importDefault(require("./routes/admin/hotwallet"));
const treasury_crypto_receipts_1 = __importDefault(require("./routes/admin/treasury-crypto-receipts"));
const treasury_crypto_assets_1 = __importDefault(require("./routes/admin/treasury-crypto-assets"));
const notifications_1 = __importDefault(require("./routes/wallet/notifications"));
const adi_deposit_1 = __importDefault(require("./routes/wallet/adi-deposit"));
const adi_payout_1 = __importDefault(require("./routes/wallet/adi-payout"));
const adi_1 = __importDefault(require("./routes/admin/adi"));
async function buildServer() {
    const server = (0, fastify_1.default)({
        logger: {
            level: env_1.env.NODE_ENV === 'production' ? 'info' : 'debug',
            ...(env_1.env.NODE_ENV !== 'production' && {
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
                },
            }),
        },
        genReqId: () => node_crypto_1.default.randomUUID(),
        ajv: {
            customOptions: {
                coerceTypes: 'array',
                useDefaults: true,
                removeAdditional: true,
            },
        },
    });
    // Body size limit — 64KB max
    server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65536 }, (req, body, done) => {
        try {
            const str = body.trim();
            done(null, str ? JSON.parse(str) : {});
        }
        catch (err) {
            done(err, undefined);
        }
    });
    // Rate limiting
    await server.register(rate_limit_1.default, {
        global: true,
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.headers['x-api-key'] ?? req.ip,
        errorResponseBuilder: () => ({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded, retry after 1 minute',
            statusCode: 429,
        }),
    });
    // Security headers
    await server.register(helmet_1.default, { global: true });
    // Multipart (for KYC document uploads)
    await server.register(multipart_1.default, { limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
    // Core plugins (order matters — supabase before hmac)
    await server.register(cors_1.default);
    await server.register(supabase_1.default);
    await server.register(hmac_1.default);
    // Health check — public, no auth
    server.get('/health', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        timestamp: { type: 'string' },
                    },
                },
            },
        },
    }, async () => ({
        status: 'ok',
        timestamp: new Date().toISOString(),
    }));
    // Versioned routes
    await server.register(async (v1) => {
        v1.register(initiate_1.default);
        v1.register(callback_1.default);
        v1.register(status_1.default);
        v1.register(auth_1.default);
        v1.register(balance_1.default);
        v1.register(transactions_1.default);
        v1.register(register_1.default);
        v1.register(login_1.default);
        v1.register(transactions_2.default);
        v1.register(balance_2.default);
        v1.register(apikey_1.default);
        v1.register(webhook_1.default);
        v1.register(kyc_1.default);
        v1.register(mode_1.default);
        v1.register(kyc_2.default);
        v1.register(auth_2.default);
        v1.register(balance_3.default);
        v1.register(deposit_1.default);
        v1.register(cglt_gaming_1.default);
        v1.register(unipesa_1.default);
        v1.register(swap_1.default);
        v1.register(withdraw_1.default);
        v1.register(transactions_3.default);
        v1.register(p2p_1.default);
        v1.register(profile_1.default);
        v1.register(kyc_3.default);
        v1.register(wallet_reconcile_1.default);
        v1.register(wallet_inspect_1.default);
        v1.register(wallet_1.default);
        v1.register(wcglt_swap_1.default);
        v1.register(internal_1.default);
        v1.register(stripe_1.default);
        v1.register(transak_1.default);
        v1.register(crypto_deposit_1.default);
        v1.register(crypto_withdraw_1.default);
        v1.register(binance_1.default);
        v1.register(hotwallet_1.default);
        v1.register(treasury_crypto_receipts_1.default);
        v1.register(treasury_crypto_assets_1.default);
        v1.register(notifications_1.default);
        v1.register(adi_deposit_1.default);
        v1.register(adi_payout_1.default);
        v1.register(adi_1.default);
    }, { prefix: '/v1' });
    /* ──────────────────────────────────────────────────────────────────────────
     * GET /api/predictstreet/users/:provider_user_id/limits
     * Server-to-server. Auth: Bearer PS_LIMITS_BEARER_TOKEN.
     * Queries user_limits, converts CDF → USD (÷ 3 600), falls back to defaults.
     * ────────────────────────────────────────────────────────────────────────── */
    server.get('/api/predictstreet/users/:provider_user_id/limits', async (req, reply) => {
        const token = env_1.env.PREDICTSTREET_BEARER_TOKEN;
        if (!token)
            return reply.code(503).send({ error: 'Limits API not configured' });
        // Constant-time bearer token comparison
        const provided = req.headers.authorization ?? '';
        const expected = `Bearer ${token}`;
        const maxLen = Math.max(provided.length, expected.length);
        const a = Buffer.from(provided.padEnd(maxLen));
        const b = Buffer.from(expected.padEnd(maxLen));
        if (a.length !== b.length || !node_crypto_1.default.timingSafeEqual(a, b)) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        const { provider_user_id } = req.params;
        const DEFAULTS = {
            deposit_limit_cdf: 180_000,
            deposit_consumed_cdf: 0,
            trade_limit_cdf: 720_000,
            trade_consumed_cdf: 0,
            withdrawal_limit_cdf: 180_000,
            withdrawal_consumed_cdf: 0,
            kyc_status: 'not_started',
        };
        const { data } = await server.supabase
            .from('user_limits')
            .select('deposit_limit_cdf,deposit_consumed_cdf,trade_limit_cdf,trade_consumed_cdf,withdrawal_limit_cdf,withdrawal_consumed_cdf,kyc_status')
            .eq('user_id', provider_user_id)
            .maybeSingle();
        const row = data ?? DEFAULTS;
        const toUsd = (cdf) => Math.round((cdf / 3600) * 100) / 100;
        return reply.send({
            deposit_limit: toUsd(Number(row.deposit_limit_cdf ?? DEFAULTS.deposit_limit_cdf)),
            deposit_consumed: toUsd(Number(row.deposit_consumed_cdf ?? DEFAULTS.deposit_consumed_cdf)),
            trade_limit: toUsd(Number(row.trade_limit_cdf ?? DEFAULTS.trade_limit_cdf)),
            trade_consumed: toUsd(Number(row.trade_consumed_cdf ?? DEFAULTS.trade_consumed_cdf)),
            withdrawal_limit: toUsd(Number(row.withdrawal_limit_cdf ?? DEFAULTS.withdrawal_limit_cdf)),
            withdrawal_consumed: toUsd(Number(row.withdrawal_consumed_cdf ?? DEFAULTS.withdrawal_consumed_cdf)),
            eligible: (row.kyc_status ?? DEFAULTS.kyc_status) === 'verified',
            kyc_status: row.kyc_status ?? DEFAULTS.kyc_status,
            currency: 'USD',
        });
    });
    // Global error handler
    server.setErrorHandler((error, request, reply) => {
        if (error.validation) {
            server.log.warn({ url: request.url, validation: error.validation }, 'Validation error');
            return reply.status(400).send({
                error: 'Validation Error',
                message: error.message,
                statusCode: 400,
            });
        }
        const statusCode = error.statusCode ?? 500;
        if (statusCode >= 500) {
            server.log.error({ err: error, reqId: request.id }, 'Server error');
        }
        else {
            server.log.warn({ statusCode, url: request.url }, error.message);
        }
        return reply.status(statusCode).send({
            error: statusCode >= 500 ? 'Internal Server Error' : error.message,
            statusCode,
        });
    });
    // 404 handler
    server.setNotFoundHandler((request, reply) => {
        reply.status(404).send({
            error: 'Not Found',
            message: `Route ${request.method} ${request.url} not found`,
            statusCode: 404,
        });
    });
    return server;
}
//# sourceMappingURL=server.js.map