"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const blockchain_1 = require("../../services/blockchain");
const walletProfileRoute = async (fastify) => {
    /* ── GET /v1/wallet/profile ─────────────────────────────── */
    fastify.get('/wallet/profile', {
        schema: {
            response: {
                200: {
                    type: 'object',
                    properties: {
                        wallet_id: { type: 'string' },
                        phone: { type: 'string' },
                        full_name: { type: ['string', 'null'] },
                        kyc_level: { type: 'number' },
                        is_verified: { type: 'boolean' },
                        balance_cdf: { type: 'number' },
                        blockchain_address: { type: ['string', 'null'] },
                        cdp_wallet_address: { type: ['string', 'null'] },
                        created_at: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const wp = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!wp)
            return reply.status(401).send({ error: 'Unauthorized' });
        const { data, error } = await fastify.supabase
            .from('wallet_users')
            .select('id, phone, full_name, kyc_level, is_verified, balance_cdf, blockchain_address, cdp_wallet_address, created_at')
            .eq('id', wp.wallet_id)
            .maybeSingle();
        if (error || !data)
            return reply.status(404).send({ error: 'Wallet not found' });
        // Auto-provision blockchain wallet for accounts created before the feature
        let blockchainAddress = data.blockchain_address ?? null;
        if (!blockchainAddress) {
            try {
                const newWallet = (0, blockchain_1.generateWallet)();
                const encryptedKey = (0, blockchain_1.encryptPrivateKey)(newWallet.privateKey);
                await fastify.supabase
                    .from('wallet_users')
                    .update({
                    blockchain_address: newWallet.address,
                    blockchain_private_key_encrypted: encryptedKey,
                })
                    .eq('id', data.id);
                blockchainAddress = newWallet.address;
                fastify.log.info({ walletId: data.id }, '[profile] blockchain wallet auto-provisioned');
            }
            catch (e) {
                fastify.log.error({ err: e, walletId: data.id }, '[profile] blockchain wallet provision failed');
            }
        }
        return reply.send({
            wallet_id: data.id,
            phone: data.phone,
            full_name: data.full_name ?? null,
            kyc_level: Number(data.kyc_level ?? 0),
            is_verified: Boolean(data.is_verified),
            balance_cdf: Number(data.balance_cdf ?? 0),
            blockchain_address: blockchainAddress,
            cdp_wallet_address: data.cdp_wallet_address ?? null,
            created_at: data.created_at,
        });
    });
    /* ── PATCH /v1/wallet/profile ───────────────────────────── */
    fastify.patch('/wallet/profile', {
        schema: {
            body: {
                type: 'object',
                required: ['full_name'],
                properties: {
                    full_name: { type: 'string', minLength: 2, maxLength: 100 },
                },
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        full_name: { type: 'string' },
                    },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'Auth service not configured' });
        const wp = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!wp)
            return reply.status(401).send({ error: 'Unauthorized' });
        const { full_name } = request.body;
        const { error } = await fastify.supabase
            .from('wallet_users')
            .update({ full_name })
            .eq('id', wp.wallet_id);
        if (error) {
            fastify.log.error({ err: error, walletId: wp.wallet_id }, 'Profile update failed');
            return reply.status(500).send({ error: 'Update failed' });
        }
        fastify.log.info({ walletId: wp.wallet_id }, 'Profile updated');
        return reply.send({ ok: true, full_name });
    });
};
exports.default = walletProfileRoute;
//# sourceMappingURL=profile.js.map