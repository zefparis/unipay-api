"use strict";
/**
 * Admin routes — BSC hot wallet monitoring.
 *
 * GET /v1/admin/hotwallet/balance
 *
 * Auth: x-admin-secret header (hmac plugin).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("../../config/env");
const bsc_withdrawal_1 = require("../../lib/bsc-withdrawal");
const adminHotwalletRoute = async (fastify) => {
    fastify.get('/admin/hotwallet/balance', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const secret = request.headers['x-admin-secret'];
        if (!env_1.env.ADMIN_SECRET || secret !== env_1.env.ADMIN_SECRET) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
        if (!env_1.env.HOT_WALLET_USDT_PRIVATE_KEY) {
            return reply.status(503).send({ error: 'Hot wallet not configured' });
        }
        try {
            const balances = await (0, bsc_withdrawal_1.getHotWalletBalances)();
            return reply.send({
                address: balances.address,
                usdt_balance: balances.usdt,
                bnb_balance: balances.bnb,
                network: 'BSC',
                contract: env_1.env.USDT_BSC_CONTRACT,
            });
        }
        catch (err) {
            fastify.log.error({ err }, 'Failed to fetch hot wallet balances');
            return reply.status(502).send({ error: 'Failed to query blockchain' });
        }
    });
};
exports.default = adminHotwalletRoute;
//# sourceMappingURL=hotwallet.js.map