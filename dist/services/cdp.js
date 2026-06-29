"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserWallet = createUserWallet;
exports.getUserWalletAddress = getUserWalletAddress;
const cdp_sdk_1 = require("@coinbase/cdp-sdk");
let _client = null;
function getClient() {
    if (!_client) {
        console.log('CDP configured:', !!process.env.CDP_API_KEY_ID);
        if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
            throw new Error('CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET must be set');
        }
        _client = new cdp_sdk_1.CdpClient({
            apiKeyId: process.env.CDP_API_KEY_ID,
            apiKeySecret: process.env.CDP_API_KEY_SECRET,
            walletSecret: process.env.CDP_WALLET_SECRET,
        });
    }
    return _client;
}
function accountName(userId) {
    return 'u-' + userId.replace(/-/g, '').slice(0, 30);
}
async function createUserWallet(userId) {
    console.log('CDP wallet creation starting for userId:', userId);
    try {
        const cdp = getClient();
        const account = await cdp.evm.getOrCreateAccount({ name: accountName(userId) });
        console.log('CDP wallet created:', account.address);
        return account.address;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('CDP wallet creation failed:', msg);
        throw err;
    }
}
async function getUserWalletAddress(userId) {
    try {
        const cdp = getClient();
        const account = await cdp.evm.getAccount({ name: accountName(userId) });
        return account.address;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=cdp.js.map