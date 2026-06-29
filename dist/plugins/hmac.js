"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../config/env");
// Paths that skip API-key validation
const PUBLIC_PATHS = new Set(['/health', '/v1/payment/callback']);
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
        // Internal routes are authenticated via x-api-key (GAMING_API_KEY) only
        if (urlPath.startsWith('/v1/internal/'))
            return;
        // PredictStreet routes use their own Bearer token auth
        if (urlPath.startsWith('/api/predictstreet/'))
            return;
        // Admin secret bypass — avoids API key requirement for admin tooling
        const adminSecretHeader = request.headers['x-admin-secret'];
        if (env_1.env.ADMIN_SECRET && adminSecretHeader === env_1.env.ADMIN_SECRET) {
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
            .select('*, operators!inner(id, name, email, status, is_admin, webhook_url)')
            .eq('key_prefix', prefix)
            .eq('is_active', true);
        if (error) {
            fastify.log.error({ err: error }, 'api_keys lookup error');
            return reply.status(500).send({ error: 'Internal Server Error', statusCode: 500 });
        }
        if (!keys || keys.length === 0) {
            return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key', statusCode: 401 });
        }
        // Find the matching hash (usually 1 candidate)
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
        if (matched.operators.status !== 'active') {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'Operator account is not active',
                statusCode: 403,
            });
        }
        // Attach to request
        request.operatorId = matched.operator_id;
        request.isAdmin = matched.operators.is_admin;
        // If admin via API key, verify email is in allowed list
        if (request.isAdmin && matched.operators.email) {
            const allowedEmails = env_1.env.ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase());
            if (!allowedEmails.includes(matched.operators.email.toLowerCase())) {
                fastify.log.warn({ email: matched.operators.email, operatorId: matched.operator_id }, 'Admin access denied: email not in ADMIN_EMAILS list');
                request.isAdmin = false;
            }
        }
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