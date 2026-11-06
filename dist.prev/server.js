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
const support_1 = __importDefault(require("./routes/merchant/support"));
const settlement_1 = __importDefault(require("./routes/merchant/settlement"));
const profile_1 = __importDefault(require("./routes/merchant/profile"));
const password_reset_1 = __importDefault(require("./routes/merchant/password-reset"));
const kyc_2 = __importDefault(require("./routes/admin/kyc"));
const settlements_1 = __importDefault(require("./routes/admin/settlements"));
const action_log_1 = __importDefault(require("./routes/admin/action-log"));
const operators_1 = __importDefault(require("./routes/status/operators"));
const auth_2 = __importDefault(require("./routes/wallet/auth"));
const balance_3 = __importDefault(require("./routes/wallet/balance"));
const deposit_1 = __importDefault(require("./routes/wallet/deposit"));
const withdraw_1 = __importDefault(require("./routes/wallet/withdraw"));
const swap_1 = __importDefault(require("./routes/wallet/swap"));
const cglt_gaming_1 = __importDefault(require("./routes/wallet/cglt-gaming"));
const unipesa_1 = __importDefault(require("./routes/wallet/unipesa"));
const transactions_3 = __importDefault(require("./routes/wallet/transactions"));
const p2p_1 = __importDefault(require("./routes/wallet/p2p"));
const profile_2 = __importDefault(require("./routes/wallet/profile"));
const kyc_3 = __importDefault(require("./routes/wallet/kyc"));
const support_2 = __importDefault(require("./routes/wallet/support"));
const wallet_reconcile_1 = __importDefault(require("./routes/admin/wallet-reconcile"));
const wallet_inspect_1 = __importDefault(require("./routes/admin/wallet-inspect"));
const wallet_1 = __importDefault(require("./routes/admin/wallet"));
const merchants_1 = __importDefault(require("./routes/admin/merchants"));
const support_3 = __importDefault(require("./routes/admin/support"));
const wcglt_swap_1 = __importDefault(require("./routes/wallet/wcglt-swap"));
const internal_1 = __importDefault(require("./routes/wallet/internal"));
const stripe_1 = __importDefault(require("./routes/wallet/stripe"));
const transak_1 = __importDefault(require("./routes/wallet/transak"));
const crypto_deposit_1 = __importDefault(require("./routes/wallet/crypto-deposit"));
const crypto_withdraw_1 = __importDefault(require("./routes/wallet/crypto-withdraw"));
const sensitive_session_1 = __importDefault(require("./routes/wallet/sensitive-session"));
const hotwallet_1 = __importDefault(require("./routes/admin/hotwallet"));
const treasury_crypto_receipts_1 = __importDefault(require("./routes/admin/treasury-crypto-receipts"));
const treasury_crypto_assets_1 = __importDefault(require("./routes/admin/treasury-crypto-assets"));
const notifications_1 = __importDefault(require("./routes/wallet/notifications"));
const dev_expenses_1 = __importDefault(require("./routes/admin/dev-expenses"));
const creditors_1 = __importDefault(require("./routes/admin/creditors"));
const quotes_1 = __importDefault(require("./routes/admin/quotes"));
const dev_expenses_v4_1 = __importDefault(require("./routes/admin/dev-expenses-v4"));
const expense_entities_1 = __importDefault(require("./routes/admin/expense-entities"));
const cglt_health_1 = __importDefault(require("./routes/admin/cglt-health"));
const onchain_reconciliation_1 = __importDefault(require("./routes/admin/onchain-reconciliation"));
const cglt_config_validator_1 = require("./config/cglt-config-validator");
const client_ip_1 = require("./lib/client-ip");
async function buildServer() {
    const server = (0, fastify_1.default)({
        // Ne faire confiance qu'aux sauts privés : cloudflared tourne sur le
        // même hôte (socket 127.0.0.1) et l'entrée XFF ajoutée en queue par
        // Cloudflare est le premier saut non privé → req.ip = IP réelle du
        // client. Un X-Forwarded-For forgé en tête de chaîne est ignoré.
        // Les clients du BFF Vercel sont départagés par l'en-tête signé
        // (voir rateLimitKey dans lib/client-ip).
        trustProxy: client_ip_1.trustedProxy,
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
        // IP signée du BFF quand elle est valide (les marchands via Vercel
        // ne partagent plus le compteur des IP de sortie Vercel), sinon
        // req.ip — déjà corrigée par trustProxy restreint aux sauts privés.
        // Jamais un en-tête client non vérifié (x-api-key) ici.
        keyGenerator: client_ip_1.rateLimitKey,
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
    // Public operator status — no auth (public status page)
    server.register(operators_1.default);
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
        v1.register(support_1.default);
        v1.register(settlement_1.default);
        v1.register(profile_1.default);
        v1.register(password_reset_1.default);
        v1.register(kyc_2.default);
        v1.register(settlements_1.default);
        v1.register(action_log_1.default);
        v1.register(auth_2.default);
        v1.register(balance_3.default);
        v1.register(deposit_1.default);
        v1.register(cglt_gaming_1.default);
        v1.register(unipesa_1.default);
        v1.register(swap_1.default);
        v1.register(withdraw_1.default);
        v1.register(transactions_3.default);
        v1.register(p2p_1.default);
        v1.register(profile_2.default);
        v1.register(kyc_3.default);
        v1.register(support_2.default);
        v1.register(wallet_reconcile_1.default);
        v1.register(wallet_inspect_1.default);
        v1.register(wallet_1.default);
        v1.register(merchants_1.default);
        v1.register(support_3.default);
        v1.register(wcglt_swap_1.default);
        v1.register(internal_1.default);
        v1.register(stripe_1.default);
        v1.register(transak_1.default);
        v1.register(crypto_deposit_1.default);
        v1.register(crypto_withdraw_1.default);
        v1.register(sensitive_session_1.default);
        v1.register(hotwallet_1.default);
        v1.register(treasury_crypto_receipts_1.default);
        v1.register(treasury_crypto_assets_1.default);
        v1.register(notifications_1.default);
        v1.register(creditors_1.default);
        v1.register(quotes_1.default);
        v1.register(dev_expenses_1.default);
        v1.register(dev_expenses_v4_1.default);
        v1.register(expense_entities_1.default);
        v1.register(cglt_health_1.default);
        v1.register(onchain_reconciliation_1.default);
    }, { prefix: '/v1' });
    /* ──────────────────────────────────────────────────────────────────────────
     * GET /dev-expenses/report/:token — PUBLIC, token-protected, rate-limited.
     * Registered without /v1 prefix so the public page can call it directly.
     * CORS: DEV_EXPENSES_PUBLIC_ORIGIN is included in the global corsPlugin.
     * Note: admin routes from this plugin are also available at /admin/dev-expenses/*
     * (without /v1) in addition to /v1/admin/dev-expenses/* — both require admin auth.
     * ────────────────────────────────────────────────────────────────────────── */
    await server.register(dev_expenses_1.default);
    // CGLT blockchain config validation — non-blocking, forces disabled on failure
    void (0, cglt_config_validator_1.validateCgltConfig)(server.log).catch((err) => {
        server.log.error({ err }, '[CGLT_CONFIG_INVALID] Validation failed to run');
    });
    // Global error handler
    server.setErrorHandler((error, request, reply) => {
        const err = error;
        if (err.validation) {
            server.log.warn({ url: request.url, validation: err.validation }, 'Validation error');
            return reply.status(400).send({
                error: 'Validation Error',
                message: err.message,
                statusCode: 400,
            });
        }
        const statusCode = err.statusCode ?? 500;
        if (statusCode >= 500) {
            server.log.error({ err: err, reqId: request.id }, 'Server error');
        }
        else {
            server.log.warn({ statusCode, url: request.url }, err.message);
        }
        return reply.status(statusCode).send({
            error: statusCode >= 500 ? 'Internal Server Error' : err.message,
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