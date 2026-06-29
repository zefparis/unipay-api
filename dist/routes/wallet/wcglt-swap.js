"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
const blockchain_1 = require("../../services/blockchain");
const CGLT_PER_WCGLT = parseInt(process.env.CGLT_PER_WCGLT ?? '500', 10);
const wcgltSwapRoute = async (fastify) => {
    fastify.post('/wallet/wcglt-to-usdt', {
        schema: {
            body: {
                type: 'object',
                required: ['cglt_amount', 'bsc_recipient'],
                properties: {
                    cglt_amount: { type: 'number', minimum: 1 },
                    bsc_recipient: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
                },
            },
        },
    }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET) {
            return reply.status(500).send({ error: 'Auth service not configured', statusCode: 500 });
        }
        const payload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!payload) {
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        }
        const cgltAmount = Math.trunc(Number(request.body.cglt_amount));
        if (!Number.isFinite(cgltAmount) || cgltAmount < CGLT_PER_WCGLT) {
            return reply.status(400).send({ error: 'invalid_amount', min: CGLT_PER_WCGLT });
        }
        if (cgltAmount % CGLT_PER_WCGLT !== 0) {
            return reply.status(400).send({ error: 'amount_not_multiple', multiple: CGLT_PER_WCGLT });
        }
        const bscRecipient = request.body.bsc_recipient.trim();
        const { data: wallet } = await fastify.supabase
            .from('wallet_users')
            .select('id, cglt_balance')
            .eq('id', payload.wallet_id)
            .maybeSingle();
        if (!wallet) {
            return reply.status(404).send({ error: 'wallet_not_found' });
        }
        const cgltBalance = Number(wallet.cglt_balance ?? 0);
        if (cgltAmount > cgltBalance) {
            return reply.status(402).send({ error: 'insufficient_cglt', available: cgltBalance });
        }
        const wcgltAmount = cgltAmount / CGLT_PER_WCGLT;
        const orderId = node_crypto_1.default.randomUUID();
        const reference = `WCS-${orderId.slice(0, 8).toUpperCase()}`;
        // Débiter CGLT avant le swap
        await fastify.supabase
            .from('wallet_users')
            .update({ cglt_balance: cgltBalance - cgltAmount })
            .eq('id', payload.wallet_id);
        // Swap wCGLT → USDT sur BSC via PancakeSwap
        let result;
        try {
            result = await (0, blockchain_1.swapWCGLTtoUSDT)(wcgltAmount, bscRecipient);
        }
        catch (e) {
            // Rembourser si échec
            await fastify.supabase
                .from('wallet_users')
                .update({ cglt_balance: cgltBalance })
                .eq('id', payload.wallet_id);
            fastify.log.error({ err: e }, '[wcglt-swap] swap failed — CGLT refunded');
            return reply.status(502).send({ error: 'swap_failed' });
        }
        // Enregistrer la transaction
        await fastify.supabase.from('transactions').insert({
            id: orderId,
            wallet_user_id: wallet.id,
            operator: 'wcglt_swap',
            direction: 'swap',
            amount: cgltAmount,
            fee: 0,
            net_amount: result.usdtReceived,
            currency: 'CGLT',
            reference,
            cglt_amount: cgltAmount,
            blockchain_tx_hash: result.txHash,
            status: 'success',
            metadata: {
                wcglt_amount: wcgltAmount,
                usdt_received: result.usdtReceived,
                bsc_recipient: bscRecipient,
            },
        });
        fastify.log.info({ walletId: payload.wallet_id, cgltAmount, wcgltAmount, usdtReceived: result.usdtReceived, txHash: result.txHash }, '[wcglt-swap] completed');
        return reply.status(201).send({
            success: true,
            cglt_spent: cgltAmount,
            wcglt_swapped: wcgltAmount,
            usdt_received: result.usdtReceived,
            bsc_tx_hash: result.txHash,
            bsc_recipient: bscRecipient,
        });
    });
};
exports.default = wcgltSwapRoute;
//# sourceMappingURL=wcglt-swap.js.map