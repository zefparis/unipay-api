"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_TOKENS = void 0;
exports.deriveDepositAddress = deriveDepositAddress;
const ethers_1 = require("ethers");
const env_1 = require("../../config/env");
const wallet_auth_1 = require("../../lib/wallet-auth");
exports.SUPPORTED_TOKENS = [
    {
        symbol: 'USDT',
        contract: env_1.env.USDT_BSC_CONTRACT ?? '',
        decimals: 18,
        name: 'Tether USD',
    },
    {
        symbol: 'wCGLT',
        contract: env_1.env.BSC_WCGLT_ADDRESS ?? '',
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
        const auth = await (0, wallet_auth_1.requireActiveWallet)(request, fastify.supabase, 'id, phone');
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { payload } = auth;
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
        const auth = await (0, wallet_auth_1.requireActiveWallet)(request, fastify.supabase, 'id, phone');
        if (!auth.ok)
            return reply.status(auth.status).send(auth.error);
        const { payload } = auth;
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