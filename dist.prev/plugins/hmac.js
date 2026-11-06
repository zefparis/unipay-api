"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../config/env");
const secret_compare_1 = require("../security/secret-compare");
// Paths that skip API-key validation
const PUBLIC_PATHS = new Set(['/health', '/v1/payment/callback', '/status/operators']);
const hmacPlugin = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        const urlPath = request.url.split('?')[0];
        if (PUBLIC_PATHS.has(urlPath))
            return;
        // Merchant routes use JWT auth — handled inside each route
        if (urlPath.startsWith('/v1/merchant/'))
            return;
        // Wallet routes use wallet JWT auth — handled inside each route
        if (urlPath.startsWith('/v1/wallet/'))
            return;
        if (urlPath.startsWith('/api/wallet/'))
            return;
        // Internal routes are authenticated via x-api-key (BRIDGE_INBOUND_API_KEY or legacy GAMING_API_KEY)
        if (urlPath.startsWith('/v1/internal/'))
            return;
        // Dev Expenses public report — token-protected, no admin auth
        if (urlPath.startsWith('/dev-expenses/report/'))
            return;
        // Admin secret bypass — accepts either ADMIN_SECRET (interactive dashboard)
        // or CRON_SERVICE_SECRET (automated cron jobs). Both grant the same admin
        // privileges but are independent secrets so each can be rotated without
        // affecting the other. Uses constant-time comparison via matchesAnySecret.
        const adminSecretHeader = request.headers['x-admin-secret'];
        if ((0, secret_compare_1.matchesAnySecret)(adminSecretHeader, [env_1.env.ADMIN_SECRET, env_1.env.CRON_SERVICE_SECRET])) {
            request.isAdmin = true;
            request.operatorId = 'admin';
            return;
        }
        const apiKey = request.headers['x-api-key'];
        if (!apiKey || typeof apiKey !== 'string') {
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Missing X-API-Key header',
                statusCode: 401,
            });
        }
        // Efficient lookup: match by the first 12 chars stored as key_prefix
        const prefix = apiKey.substring(0, 12);
        const { data: keys, error } = await fastify.supabase
            .from('api_keys')
            .select('*, merchants!inner(id, name, email, status, access_status, webhook_url), is_internal')
            .eq('key_prefix', prefix)
            .eq('is_active', true);
        if (error) {
            fastify.log.error({ err: error }, 'api_keys lookup error');
            return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        if (!keys || keys.length === 0) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
        }
        // Find the matching hash — bcrypt hash is salted, so we must run
        // bcrypt.compare against every candidate returned by the prefix lookup
        // (the 12-char prefix can collide across keys, though rarely).
        let matched = null;
        for (const k of keys) {
            if (await bcryptjs_1.default.compare(apiKey, k.key_hash)) {
                matched = k;
                break;
            }
        }
        if (!matched) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
        }
        if (matched.merchants.status !== 'active') {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Operator account is not active',
                statusCode: 403,
            });
        }
        // Conformité KYC : clés sandbox ET live bloquées tant que le dossier
        // n'est pas validé (access_status ≠ 'active'). Les clés marquées
        // is_internal ne sont exemptées que sur les routes internes/cglt —
        // sur toute autre route elles sont traitées normalement.
        const isInternalRoute = urlPath.startsWith('/v1/internal/') || urlPath.startsWith('/v1/wallet/cglt-');
        const exempt = matched.is_internal === true && isInternalRoute;
        if (!exempt && matched.merchants.access_status !== 'active') {
            return reply.status(403).send({
                error: 'Vérification de votre dossier requise — envoyez vos documents KYC depuis votre espace marchand.',
                code: 'KYC_REQUIRED',
                statusCode: 403,
            });
        }
        // Attach to request
        request.operatorId = matched.merchant_id;
        request.isAdmin = false; // merchants table has no is_admin column
        // Update last_used_at — non-blocking
        void Promise.resolve(fastify.supabase
            .from('api_keys')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', matched.id)).catch(() => { });
    });
};
exports.default = (0, fastify_plugin_1.default)(hmacPlugin, {
    name: 'hmac-auth',
    dependencies: ['supabase-plugin'],
});
//# sourceMappingURL=hmac.js.map