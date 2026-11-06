"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../../config/env");
const jwt_1 = require("../../utils/jwt");
const email_login_limiter_1 = require("../../lib/email-login-limiter");
const client_ip_1 = require("../../lib/client-ip");
// Dummy hash for constant-time login (M8: eliminate timing oracle).
// This hash is used when the account doesn't exist, so bcrypt.compare
// always runs — whether the account exists or not, the response time
// includes a full bcrypt comparison.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const loginRoute = async (fastify) => {
    fastify.post('/merchant/login', {
        // CGNAT RDC : pas de limite stricte par IP (des milliers de
        // clients partagent une IP mobile). Garde large anti-bourrage ;
        // la vraie limite est par identifiant dans le handler.
        config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: client_ip_1.rateLimitKey } },
        schema: {
            body: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 1 },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        access_token: { type: 'string' },
                        token_type: { type: 'string' },
                        expires_in: { type: 'number' },
                        merchant_id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            fastify.log.error('JWT_SECRET not configured');
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const { email, password } = request.body;
        // Limite par identifiant : 5 tentatives/min par email (bloque le
        // stuffing ciblé sans pénaliser les voisins de CGNAT).
        if (!(0, email_login_limiter_1.loginEmailAllowed)(email)) {
            return reply.status(429).send({ error: 'Trop de tentatives de connexion, réessayez dans une minute.', statusCode: 429 });
        }
        const { data: merchant, error } = await fastify.supabase
            .from('merchants')
            .select('id, name, email, password_hash, status, token_version')
            .eq('email', email)
            .maybeSingle();
        // M8: uniform 401 "Invalid credentials" in all failure cases.
        // The real reason is logged server-side for support/debugging.
        // bcrypt.compare always runs (against DUMMY_HASH if account
        // doesn't exist) to eliminate the timing oracle.
        const accountExists = !error && merchant;
        const hashToCompare = accountExists
            ? merchant.password_hash
            : DUMMY_HASH;
        const passwordMatch = await bcryptjs_1.default.compare(password, hashToCompare);
        if (!accountExists) {
            fastify.log.info({ email, reason: 'account_not_found' }, '[login] failed');
            return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
        }
        if (merchant.status !== 'active') {
            fastify.log.info({ merchantId: merchant.id, email, reason: 'inactive_account', status: merchant.status }, '[login] failed');
            return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
        }
        if (!passwordMatch) {
            fastify.log.info({ merchantId: merchant.id, email, reason: 'invalid_password' }, '[login] failed');
            return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
        }
        const EXPIRES_IN = 86_400; // 24 hours
        const token = (0, jwt_1.signToken)({ merchant_id: merchant.id, email: merchant.email, token_version: merchant.token_version ?? 0 }, env_1.env.JWT_SECRET, EXPIRES_IN);
        fastify.log.info({ merchantId: merchant.id }, 'Merchant login');
        return {
            access_token: token,
            token_type: 'Bearer',
            expires_in: EXPIRES_IN,
            merchant_id: merchant.id,
            name: merchant.name,
            email: merchant.email,
        };
    });
};
exports.default = loginRoute;
//# sourceMappingURL=login.js.map