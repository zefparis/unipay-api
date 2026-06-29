"use strict";
/**
 * ADI Chain hot-wallet USDC withdrawal service.
 *
 * Sends USDC ERC-20 directly on-chain from the UniPay settlement wallet.
 * USDC on ADI Chain uses 6 decimals (standard USDC precision).
 * Chain ID: 36900 — RPC: https://rpc.adifoundation.ai
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdiWalletBalances = getAdiWalletBalances;
exports.sendUsdc = sendUsdc;
exports.waitForConfirmations = waitForConfirmations;
exports.getAdiTransactionReceipt = getAdiTransactionReceipt;
const ethers_1 = require("ethers");
const env_1 = require("../config/env");
/* ── Minimal ERC-20 ABI (transfer + balanceOf) ────────────────────────── */
const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
];
/* ── Safety threshold: hot wallet must hold at least this much ADI for gas */
const ADI_GAS_MIN = ethers_1.ethers.parseEther('0.01'); // 0.01 ADI native coin
/* ── Required confirmations before a deposit is considered settled ─────── */
const DEFAULT_CONFIRMATIONS = 12;
/* ── Provider / signer helpers ─────────────────────────────────────────── */
function getProvider() {
    return new ethers_1.ethers.JsonRpcProvider(env_1.env.ADI_RPC_URL);
}
function getSettlementWallet() {
    const key = env_1.env.ADI_SETTLEMENT_PRIVATE_KEY;
    if (!key)
        throw new Error('ADI_SETTLEMENT_PRIVATE_KEY not configured');
    return new ethers_1.ethers.Wallet(key, getProvider());
}
/**
 * Returns current USDC and ADI native balances of the settlement wallet.
 * Used by the admin monitoring route.
 */
async function getAdiWalletBalances() {
    const wallet = getSettlementWallet();
    const provider = getProvider();
    const contract = new ethers_1.ethers.Contract(env_1.env.ADI_USDC_CONTRACT, ERC20_ABI, provider);
    const [usdcRaw, adiRaw] = await Promise.all([
        contract.balanceOf(wallet.address),
        provider.getBalance(wallet.address),
    ]);
    return {
        address: wallet.address,
        usdc: ethers_1.ethers.formatUnits(usdcRaw, 6),
        adi: ethers_1.ethers.formatEther(adiRaw),
    };
}
/**
 * Sends `amount` USDC from the settlement wallet to `to` on ADI Chain.
 *
 * Throws:
 *  - 'INVALID_ADDRESS'                 if `to` is not a valid EVM address
 *  - 'INSUFFICIENT_HOT_WALLET_BALANCE' if wallet USDC < amount
 *  - 'INSUFFICIENT_GAS'                if wallet ADI native < ADI_GAS_MIN
 */
async function sendUsdc({ to, amount }) {
    /* 1. Validate destination address */
    if (!ethers_1.ethers.isAddress(to)) {
        throw new Error('INVALID_ADDRESS');
    }
    const wallet = getSettlementWallet();
    const contract = new ethers_1.ethers.Contract(env_1.env.ADI_USDC_CONTRACT, ERC20_ABI, wallet);
    const provider = wallet.provider;
    const amountWei = ethers_1.ethers.parseUnits(amount.toString(), 6);
    /* 2. Check USDC balance */
    const usdcBalance = (await contract.balanceOf(wallet.address));
    if (usdcBalance < amountWei) {
        throw new Error('INSUFFICIENT_HOT_WALLET_BALANCE');
    }
    /* 3. Check ADI native coin for gas */
    const adiBalance = await provider.getBalance(wallet.address);
    if (adiBalance < ADI_GAS_MIN) {
        throw new Error('INSUFFICIENT_GAS');
    }
    /* 4. Execute transfer — wait for 1 confirmation before returning txHash */
    const tx = await contract.transfer(to, amountWei);
    const receipt = await tx.wait(1);
    if (!receipt)
        throw new Error('Transaction receipt not received');
    return { txHash: receipt.hash };
}
/**
 * Polls the chain until `txHash` has at least `confirmations` blocks on top.
 * Returns true when confirmed, false on timeout (max 120s).
 */
async function waitForConfirmations(txHash, confirmations = DEFAULT_CONFIRMATIONS) {
    const provider = getProvider();
    const deadline = Date.now() + 120_000; // 2-minute hard timeout
    const pollMs = 3_000; // poll every 3s
    while (Date.now() < deadline) {
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        if (receipt) {
            const currentConfirmations = await receipt.confirmations().catch(() => 0);
            if (currentConfirmations >= confirmations)
                return true;
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
}
/**
 * Fetches the raw transaction receipt from the ADI Chain RPC.
 * Returns null if the transaction is not yet indexed.
 */
async function getAdiTransactionReceipt(txHash) {
    const provider = getProvider();
    return provider.getTransactionReceipt(txHash).catch(() => null);
}
//# sourceMappingURL=adi-withdrawal.js.map