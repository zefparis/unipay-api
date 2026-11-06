"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const env_1 = require("../../config/env");
const merchant_auth_1 = require("../../lib/merchant-auth");
const merchantApikeyRoute = async (fastify) => {
    fastify.post('/merchant/apikey', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    label: { type: 'string', maxLength: 64 },
                },
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        api_key: { type: 'string' },
                        key_prefix: { type: 'string' },
                        label: { type: 'string' },
                        note: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const auth = await (0, merchant_auth_1.requireActiveMerchant)(request, fastify.supabase);
        if (!auth.ok) {
            return reply.status(auth.status).send(auth.error);
        }
        const label = request.body?.label ?? 'default';
        // Deactivate any existing key with the same label for this merchant
        await fastify.supabase
            .from('api_keys')
            .update({ is_active: false })
            .eq('merchant_id', auth.payload.merchant_id)
            .eq('label', label);
        // Generate new key: upk_live_ prefix + 32 random hex chars
        const rawKey = `upk_live_${node_crypto_1.default.randomBytes(24).toString('hex')}`;
        const keyPrefix = rawKey.substring(0, 12);
        const keyHash = await bcryptjs_1.default.hash(rawKey, 10);
        const { error } = await fastify.supabase.from('api_keys').insert({
            merchant_id: auth.payload.merchant_id,
            key_prefix: keyPrefix,
            key_hash: keyHash,
            label,
            is_active: true,
        });
        if (error) {
            fastify.log.error({ err: error, merchantId: auth.payload.merchant_id }, 'API key generation failed');
            return reply.status(500).send({ error: 'Key generation failed', statusCode: 500 });
        }
        fastify.log.info({ merchantId: auth.payload.merchant_id, label }, 'API key generated');
        return reply.status(201).send({
            api_key: rawKey,
            key_prefix: keyPrefix,
            label,
            note: 'Store this key securely — it will not be shown again.',
        });
    });
};
exports.default = merchantApikeyRoute;
//# sourceMappingURL=apikey.js.map