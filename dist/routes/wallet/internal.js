"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../../config/env");
const cdp_1 = require("../../services/cdp");
const walletInternalRoute = async (fastify) => {
    /* ── GET /v1/internal/bsc-addresses ─────────────────────── */
    fastify.get('/internal/bsc-addresses', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        if (request.headers['x-api-key'] !== env_1.env.GAMING_API_KEY) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
        const { data, error } = await fastify.supabase
            .from('wallet_users')
            .select('phone, blockchain_address')
            .not('blockchain_address', 'is', null);
        if (error) {
            fastify.log.error({ err: error }, '[internal] bsc-addresses fetch failed');
            return reply.status(500).send({ error: 'Database error' });
        }
        const normalized = (data ?? []).map((row) => ({
            ...row,
            blockchain_address: row.blockchain_address?.toLowerCase() ?? null,
        }));
        return reply.send(normalized);
    });
    /* ── POST /v1/wallet/cglt-credit-incoming ───────────────── */
    fastify.post('/wallet/cglt-credit-incoming', {
        schema: {
            body: {
                type: 'object',
                required: ['phone', 'cglt_amount', 'tx_hash', 'bsc_address'],
                properties: {
                    phone: { type: 'string' },
                    cglt_amount: { type: 'number', minimum: 1 },
                    tx_hash: { type: 'string' },
                    bsc_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
                },
            },
        },
    }, async (request, reply) => {
        if (request.headers['x-api-key'] !== env_1.env.GAMING_API_KEY) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
        const { phone, cglt_amount, tx_hash } = request.body;
        const bsc_address = request.body.bsc_address.toLowerCase();
        // Idempotence — vérifie si la tx est déjà traitée
        const { data: existing } = await fastify.supabase
            .from('transactions')
            .select('id')
            .eq('blockchain_tx_hash', tx_hash)
            .maybeSingle();
        if (existing) {
            return reply.send({ success: true, already_processed: true });
        }
        // Retrouver le wallet par adresse BSC
        const { data: wallet } = await fastify.supabase
            .from('wallet_users')
            .select('id, cglt_balance')
            .ilike('blockchain_address', bsc_address) // case-insensitive match
            .maybeSingle();
        if (!wallet) {
            return reply.status(404).send({ error: 'wallet_not_found' });
        }
        const newBalance = Number(wallet.cglt_balance ?? 0) + cglt_amount;
        await fastify.supabase
            .from('wallet_users')
            .update({ cglt_balance: newBalance })
            .eq('id', wallet.id);
        await fastify.supabase.from('transactions').insert({
            id: node_crypto_1.default.randomUUID(),
            wallet_user_id: wallet.id,
            operator: 'cglt',
            direction: 'collect',
            amount: cglt_amount,
            fee: 0,
            net_amount: cglt_amount,
            currency: 'CGLT',
            phone,
            reference: `WCGLT-IN-${tx_hash.slice(0, 8).toUpperCase()}`,
            blockchain_tx_hash: tx_hash,
            cglt_amount,
            status: 'success',
            metadata: { source: 'wcglt_incoming', bsc_address },
        });
        fastify.log.info({ walletId: wallet.id, phone, cglt_amount, tx_hash }, '[internal] CGLT credited from incoming wCGLT');
        return reply.send({ success: true, new_balance: newBalance });
    });
    /* ── POST /v1/internal/backfill-cdp-wallets ────────────── */
    fastify.post('/internal/backfill-cdp-wallets', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
        const adminSecret = process.env.ADMIN_SECRET ?? '';
        if (!adminSecret || request.headers['x-admin-secret'] !== adminSecret) {
            return reply.status(403).send({ error: 'Forbidden' });
        }
        const { data: users, error } = await fastify.supabase
            .from('wallet_users')
            .select('id')
            .is('cdp_wallet_address', null)
            .limit(50);
        if (error) {
            fastify.log.error({ err: error }, '[backfill] query failed');
            return reply.status(500).send({ error: 'Database error' });
        }
        let processed = 0;
        let errors = 0;
        for (const user of users ?? []) {
            try {
                const address = await (0, cdp_1.createUserWallet)(user.id);
                await fastify.supabase
                    .from('wallet_users')
                    .update({ cdp_wallet_address: address })
                    .eq('id', user.id);
                processed++;
                fastify.log.info({ userId: user.id, address }, '[backfill] CDP wallet created');
            }
            catch (err) {
                errors++;
                fastify.log.error({ err, userId: user.id }, '[backfill] CDP wallet creation failed');
            }
        }
        return reply.send({
            ok: true,
            processed,
            errors,
            remaining: (users?.length ?? 0) === 50 ? 'more' : 'none',
        });
    });
};
exports.default = walletInternalRoute;
//# sourceMappingURL=internal.js.map