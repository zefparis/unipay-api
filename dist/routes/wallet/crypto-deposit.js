"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_TOKENS = void 0;
exports.deriveDepositAddress = deriveDepositAddress;
const ethers_1 = require("ethers");
const env_1 = require("../../config/env");
const wallet_jwt_1 = require("../../utils/wallet-jwt");
exports.SUPPORTED_TOKENS = [
    {
        symbol: 'USDT',
        contract: '0x55d398326f99059fF775485246999027B3197955',
        decimals: 18,
        name: 'Tether USD',
    },
    {
        symbol: 'wCGLT',
        contract: '0xfE4Ce029A1CB84Aa0D3906C7eC409f1496d13A3B',
        decimals: 18,
        name: 'Wrapped CGLT',
    },
];
/* ── Deterministic BSC address from HD wallet ──────────────────────────── */
function deriveDepositAddress(hdIndex) {
    const phrase = process.env.UNIPAY_HD_WALLET_MNEMONIC;
    if (!phrase)
        throw new Error('UNIPAY_HD_WALLET_MNEMONIC not configured');
    const mnemonic = ethers_1.Mnemonic.fromPhrase(phrase);
    const wallet = ethers_1.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${hdIndex}`);
    return wallet.address;
}
/* ── Fastify plugin ─────────────────────────────────────────────────────── */
const walletCryptoDepositRoute = async (fastify) => {
    /* ──────────────────────────────────────────────────────────────────────
     * GET /v1/wallet/deposit-address
     * Auth: wallet JWT
     * Returns (or creates) the unique BSC deposit address for this user.
     * ────────────────────────────────────────────────────────────────────── */
    fastify.get('/wallet/deposit-address', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'auth_not_configured' });
        const payload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!payload)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        if (!process.env.UNIPAY_HD_WALLET_MNEMONIC) {
            return reply.status(503).send({ error: 'crypto_deposits_not_configured' });
        }
        // Check for existing address
        const { data: existing } = await fastify.supabase
            .from('user_deposit_addresses')
            .select('bsc_address, hd_index')
            .eq('user_id', payload.wallet_id)
            .maybeSingle();
        let bscAddress;
        if (existing) {
            bscAddress = existing.bsc_address;
        }
        else {
            // Derive next index = current count of all addresses
            const { count } = await fastify.supabase
                .from('user_deposit_addresses')
                .select('*', { count: 'exact', head: true });
            const hdIndex = (count ?? 0);
            bscAddress = deriveDepositAddress(hdIndex);
            const { error: dbErr } = await fastify.supabase
                .from('user_deposit_addresses')
                .insert({ user_id: payload.wallet_id, bsc_address: bscAddress, hd_index: hdIndex });
            if (dbErr) {
                fastify.log.error({ err: dbErr }, '[crypto-deposit] address insert failed');
                return reply.status(500).send({ error: 'address_create_failed' });
            }
            fastify.log.info({ userId: payload.wallet_id, bscAddress, hdIndex }, '[crypto-deposit] new deposit address created');
        }
        return reply.send({
            bsc_address: bscAddress,
            supported_tokens: exports.SUPPORTED_TOKENS,
            network: 'BSC (BEP-20)',
            warning: 'Envoyer uniquement USDT ou wCGLT sur le réseau BSC (BNB Smart Chain). Tout autre token sera perdu définitivement.',
        });
    });
    /* ──────────────────────────────────────────────────────────────────────
     * GET /v1/wallet/deposits
     * Auth: wallet JWT
     * Returns last 20 confirmed crypto deposits for this user.
     * ────────────────────────────────────────────────────────────────────── */
    fastify.get('/wallet/deposits', async (request, reply) => {
        if (!env_1.env.JWT_SECRET)
            return reply.status(500).send({ error: 'auth_not_configured' });
        const payload = (0, wallet_jwt_1.requireWallet)(request.headers.authorization, env_1.env.JWT_SECRET);
        if (!payload)
            return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
        const { data: deposits } = await fastify.supabase
            .from('crypto_deposits')
            .select('id, tx_hash, token_symbol, amount_usd, from_address, block_number, status, created_at')
            .eq('user_id', payload.wallet_id)
            .order('created_at', { ascending: false })
            .limit(20);
        return reply.send(deposits ?? []);
    });
};
exports.default = walletCryptoDepositRoute;
//# sourceMappingURL=crypto-deposit.js.map