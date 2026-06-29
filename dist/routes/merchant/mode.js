"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_js_1 = require("../../config/env.js");
const jwt_js_1 = require("../../utils/jwt.js");
function requireMerchant(auth, secret) {
    if (!auth?.startsWith('Bearer '))
        return null;
    const payload = (0, jwt_js_1.verifyToken)(auth.slice(7), secret);
    return payload?.merchant_id ?? null;
}
const merchantModeRoute = async (fastify) => {
    /* ── GET /v1/merchant/mode ──────────────────────────────── */
    fastify.get('/merchant/mode', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string' },
                        kyc_status: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const merchantId = requireMerchant(request.headers.authorization, env_js_1.env.JWT_SECRET);
        if (!merchantId)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { data } = await fastify.supabase
            .from('merchants')
            .select('mode, kyc_status')
            .eq('id', merchantId)
            .maybeSingle();
        return reply.send({
            mode: (data?.mode ?? 'sandbox'),
            kyc_status: data?.kyc_status ?? 'pending',
        });
    });
    /* ── POST /v1/merchant/mode ─────────────────────────────── */
    fastify.post('/merchant/mode', {
        schema: {
            body: {
                type: 'object',
                required: ['mode'],
                properties: {
                    mode: { type: 'string', enum: ['sandbox', 'live'] },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string' },
                        ok: { type: 'boolean' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const merchantId = requireMerchant(request.headers.authorization, env_js_1.env.JWT_SECRET);
        if (!merchantId)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { mode } = request.body;
        // Switching to live requires approved KYC
        if (mode === 'live') {
            const { data } = await fastify.supabase
                .from('merchants')
                .select('kyc_status')
                .eq('id', merchantId)
                .maybeSingle();
            if (data?.kyc_status !== 'approved') {
                return reply.status(403).send({
                    error: 'KYC approval required to switch to live mode',
                    kyc_status: data?.kyc_status ?? 'pending',
                    statusCode: 403,
                });
            }
        }
        const { error } = await fastify.supabase
            .from('merchants')
            .update({ mode })
            .eq('id', merchantId);
        if (error) {
            fastify.log.error({ err: error, merchantId }, 'Mode update failed');
            return reply.status(500).send({ error: 'Mode update failed', statusCode: 500 });
        }
        fastify.log.info({ merchantId, mode }, 'Merchant mode updated');
        return reply.send({ mode, ok: true });
    });
    /* ── POST /v1/merchant/sandbox/test ────────────────────── */
    fastify.post('/merchant/sandbox/test', {
        schema: {
            body: {
                type: 'object',
                required: ['operator', 'direction', 'amount', 'phone'],
                properties: {
                    operator: { type: 'string' },
                    direction: { type: 'string', enum: ['collect', 'payout'] },
                    amount: { type: 'number', minimum: 1 },
                    currency: { type: 'string', default: 'CDF' },
                    phone: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_js_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth not configured', statusCode: 500 });
        const merchantId = requireMerchant(request.headers.authorization, env_js_1.env.JWT_SECRET);
        if (!merchantId)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { operator, direction, amount, currency = 'CDF', phone } = request.body;
        const FEE_RATE = 0.03;
        const fee = Math.round(amount * FEE_RATE * 100) / 100;
        const net_amount = Math.round((amount - fee) * 100) / 100;
        const transactionId = node_crypto_1.default.randomUUID();
        const mockRef = `sandbox_${node_crypto_1.default.randomUUID()}`;
        const resolvedRef = `TXN-${transactionId.slice(0, 8).toUpperCase()}`;
        await fastify.supabase.from('transactions').insert({
            id: transactionId,
            merchant_id: merchantId,
            operator,
            direction,
            amount,
            fee,
            net_amount,
            currency,
            phone,
            reference: resolvedRef,
            avada_transaction_id: mockRef,
            status: 'success',
            metadata: { sandbox: true, dashboard_test: true },
        });
        fastify.log.info({ transactionId, merchantId }, 'Dashboard sandbox test transaction');
        return reply.status(201).send({
            transaction_id: transactionId,
            status: 'success',
            amount,
            fee,
            net_amount,
            currency,
            sandbox: true,
            operator,
            direction,
        });
    });
};
exports.default = merchantModeRoute;
//# sourceMappingURL=mode.js.map