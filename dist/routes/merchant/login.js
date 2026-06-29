"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../../config/env");
const jwt_1 = require("../../utils/jwt");
const loginRoute = async (fastify) => {
    fastify.post('/merchant/login', {
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
        const { data: merchant, error } = await fastify.supabase
            .from('merchants')
            .select('id, name, email, password_hash, status')
            .eq('email', email)
            .maybeSingle();
        if (error || !merchant) {
            return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
        }
        if (merchant.status !== 'active') {
            return reply.status(403).send({ error: 'Account is not active', statusCode: 403 });
        }
        const passwordMatch = await bcryptjs_1.default.compare(password, merchant.password_hash);
        if (!passwordMatch) {
            return reply.status(401).send({ error: 'Invalid credentials', statusCode: 401 });
        }
        const EXPIRES_IN = 86_400; // 24 hours
        const token = (0, jwt_1.signToken)({ merchant_id: merchant.id, email: merchant.email }, env_1.env.JWT_SECRET, EXPIRES_IN);
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