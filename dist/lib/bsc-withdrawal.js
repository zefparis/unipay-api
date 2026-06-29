"use strict";
/**
 * BSC hot-wallet USDT withdrawal service.
 *
 * Sends USDT BEP-20 directly on-chain from the UniPay hot wallet.
 * USDT on BSC uses 18 decimals (not 6 like on Ethereum/Tron).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHotWalletBalances = getHotWalletBalances;
exports.sendUsdt = sendUsdt;
const ethers_1 = require("ethers");
const env_1 = require("../config/env");
/* ── Minimal ERC-20 ABI (transfer + balanceOf) ────────────────────────── */
const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
];
/* ── Safety threshold: hot wallet must hold at least this much BNB for gas */
const BNB_GAS_MIN = ethers_1.ethers.parseEther('0.002'); // ~0.002 BNB ≈ $1
/* ── Provider / signer helpers ─────────────────────────────────────────── */
function getProvider() {
    return new ethers_1.ethers.JsonRpcProvider(env_1.env.BSC_RPC_URL);
}
function getHotWallet() {
    const key = env_1.env.HOT_WALLET_USDT_PRIVATE_KEY;
    if (!key)
        throw new Error('HOT_WALLET_USDT_PRIVATE_KEY not configured');
    return new ethers_1.ethers.Wallet(key, getProvider());
}
/**
 * Returns current USDT and BNB balances of the hot wallet.
 * Used by the admin monitoring route.
 */
async function getHotWalletBalances() {
    const wallet = getHotWallet();
    const provider = getProvider();
    const contract = new ethers_1.ethers.Contract(env_1.env.USDT_BSC_CONTRACT, ERC20_ABI, provider);
    const [usdtRaw, bnbRaw] = await Promise.all([
        contract.balanceOf(wallet.address),
        provider.getBalance(wallet.address),
    ]);
    return {
        address: wallet.address,
        usdt: ethers_1.ethers.formatUnits(usdtRaw, 18),
        bnb: ethers_1.ethers.formatEther(bnbRaw),
    };
}
/**
 * Sends `amount` USDT from the hot wallet to `to` on BSC.
 *
 * Throws:
 *  - 'INVALID_ADDRESS'                if `to` is not a valid EVM address
 *  - 'INSUFFICIENT_HOT_WALLET_BALANCE' if hot wallet USDT < amount
 *  - 'INSUFFICIENT_GAS'               if hot wallet BNB < BNB_GAS_MIN
 */
async function sendUsdt({ to, amount }) {
    /* 1. Validate destination address */
    if (!ethers_1.ethers.isAddress(to)) {
        throw new Error('INVALID_ADDRESS');
    }
    const wallet = getHotWallet();
    const contract = new ethers_1.ethers.Contract(env_1.env.USDT_BSC_CONTRACT, ERC20_ABI, wallet);
    const provider = wallet.provider;
    const amountWei = ethers_1.ethers.parseUnits(amount.toString(), 18);
    /* 2. Check USDT balance */
    const usdtBalance = (await contract.balanceOf(wallet.address));
    if (usdtBalance < amountWei) {
        throw new Error('INSUFFICIENT_HOT_WALLET_BALANCE');
    }
    /* 3. Check BNB for gas */
    const bnbBalance = await provider.getBalance(wallet.address);
    if (bnbBalance < BNB_GAS_MIN) {
        throw new Error('INSUFFICIENT_GAS');
    }
    /* 4. Execute transfer — wait for 1 confirmation */
    const tx = await contract.transfer(to, amountWei);
    const receipt = await tx.wait(1);
    if (!receipt)
        throw new Error('Transaction receipt not received');
    return { txHash: receipt.hash };
}
//# sourceMappingURL=bsc-withdrawal.js.map