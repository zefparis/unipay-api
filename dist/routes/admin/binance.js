"use strict";
/**
 * Admin routes — Binance account management.
 *
 * GET  /v1/admin/binance/balances
 * POST /v1/admin/binance/withdraw
 * GET  /v1/admin/binance/withdrawals
 *
 * Auth: x-admin-secret OR api-key with is_admin + ADMIN_EMAILS (hmac plugin).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const binance_admin_1 = require("../../lib/binance-admin");
/* ── Address validators ───────────────────────────────────────────────── */
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const TRON_ADDR = /^T[a-zA-Z0-9]{33}$/;
function isValidAddress(address, network) {
    return network === 'TRC20' ? TRON_ADDR.test(address) : EVM_ADDR.test(address);
}
/* ── Sub-account email ────────────────────────────────────────────────── */
const SUBACCOUNT_EMAIL = 'b.barrere@congogaming.com';
const adminBinanceRoute = async (fastify) => {
    /* ── GET /v1/admin/binance/balances ───────────────────────────────── */
    fastify.get('/admin/binance/balances', async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required' });
        }
        const apiKey = env_1.env.BINANCE_MAIN_API_KEY;
        const secretKey = env_1.env.BINANCE_MAIN_SECRET_KEY;
        if (!apiKey || !secretKey) {
            return reply.status(503).send({ error: 'Binance main credentials not configured' });
        }
        fastify.log.info({ ip: request.ip, ts: new Date().toISOString() }, '[admin-binance] GET balances');
        try {
            const [main, subaccount] = await Promise.allSettled([
                (0, binance_admin_1.getAccountBalance)(apiKey, secretKey),
                (0, binance_admin_1.getSubAccountBalance)(SUBACCOUNT_EMAIL, apiKey, secretKey),
            ]);
            return {
                main: main.status === 'fulfilled' ? main.value : [],
                subaccount: subaccount.status === 'fulfilled' ? subaccount.value : [],
                main_error: main.status === 'rejected' ? main.reason.message : undefined,
                subaccount_error: subaccount.status === 'rejected' ? subaccount.reason.message : undefined,
            };
        }
        catch (err) {
            fastify.log.error({ err }, '[admin-binance] balances fetch failed');
            return reply.status(502).send({ error: 'Failed to fetch Binance balances' });
        }
    });
    /* ── POST /v1/admin/binance/withdraw ──────────────────────────────── */
    fastify.post('/admin/binance/withdraw', {
        schema: {
            body: {
                type: 'object',
                required: ['amount', 'network', 'address'],
                properties: {
                    amount: { type: 'number', exclusiveMinimum: 0 },
                    network: { type: 'string', enum: ['BSC', 'TRC20', 'ERC20'] },
                    address: { type: 'string', minLength: 10, maxLength: 100 },
                },
            },
        },
    }, async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required' });
        }
        const apiKey = env_1.env.BINANCE_MAIN_API_KEY;
        const secretKey = env_1.env.BINANCE_MAIN_SECRET_KEY;
        if (!apiKey || !secretKey) {
            return reply.status(503).send({ error: 'Binance main credentials not configured' });
        }
        const { amount, network, address } = request.body;
        const addrMasked = `${address.slice(0, 6)}…${address.slice(-4)}`;
        /* ── Validate address format ──────────────────────────────────── */
        if (!isValidAddress(address, network)) {
            return reply.status(400).send({
                error: 'INVALID_ADDRESS',
                message: network === 'TRC20'
                    ? 'TRC20 address must start with T and be 34 characters'
                    : 'EVM address must be a valid 0x hex address (42 chars)',
            });
        }
        fastify.log.info({ ip: request.ip, ts: new Date().toISOString(), amount, network, addrMasked }, '[admin-binance] withdraw initiated');
        try {
            const result = await (0, binance_admin_1.withdrawUsdt)({ amount, network, address, apiKey, secretKey });
            fastify.log.info({ withdrawId: result.id, amount, network, addrMasked }, '[admin-binance] withdraw submitted to Binance');
            return reply.status(201).send({
                withdraw_id: result.id,
                status: 'processing',
                amount,
                network,
            });
        }
        catch (err) {
            const reason = err?.message ?? 'Binance error';
            fastify.log.error({ err, amount, network, addrMasked }, '[admin-binance] withdraw failed');
            return reply.status(502).send({ error: 'Withdrawal failed', detail: reason });
        }
    });
    /* ── GET /v1/admin/binance/withdrawals ────────────────────────────── */
    fastify.get('/admin/binance/withdrawals', async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required' });
        }
        const apiKey = env_1.env.BINANCE_MAIN_API_KEY;
        const secretKey = env_1.env.BINANCE_MAIN_SECRET_KEY;
        if (!apiKey || !secretKey) {
            return reply.status(503).send({ error: 'Binance main credentials not configured' });
        }
        fastify.log.info({ ip: request.ip, ts: new Date().toISOString() }, '[admin-binance] GET withdrawals');
        try {
            const withdrawals = await (0, binance_admin_1.getWithdrawHistory)(apiKey, secretKey);
            return { data: withdrawals, total: withdrawals.length };
        }
        catch (err) {
            fastify.log.error({ err }, '[admin-binance] withdraw history failed');
            return reply.status(502).send({ error: 'Failed to fetch withdrawal history' });
        }
    });
};
exports.default = adminBinanceRoute;
//# sourceMappingURL=binance.js.map