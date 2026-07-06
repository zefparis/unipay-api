/**
 * BSC hot-wallet USDT withdrawal service.
 *
 * Sends USDT BEP-20 directly on-chain from the UniPay hot wallet.
 * USDT on BSC uses 18 decimals (not 6 like on Ethereum/Tron).
 */

import { ethers } from 'ethers';
import { env } from '../config/env';

/* ── Minimal ERC-20 ABI (transfer + balanceOf) ────────────────────────── */
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

/* ── Safety threshold: hot wallet must hold at least this much BNB for gas */
const BNB_GAS_MIN = ethers.parseEther('0.002'); // ~0.002 BNB ≈ $1

/* ── Provider / signer helpers ─────────────────────────────────────────── */
function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(env.BSC_RPC_URL);
}

function getHotWallet(): ethers.Wallet {
  const key = env.HOT_WALLET_USDT_PRIVATE_KEY;
  if (!key) throw new Error('HOT_WALLET_USDT_PRIVATE_KEY not configured');
  return new ethers.Wallet(key, getProvider());
}

/* ── Address guard ───────────────────────────────────────────────────────── */

/**
 * Returns true if `address` is a smart contract (has bytecode), false if it's
 * an EOA (externally owned account). Uses eth_getCode which returns '0x' for
 * plain wallets and non-empty hex for any contract.
 */
export async function isContractAddress(address: string): Promise<boolean> {
  const provider = getProvider();
  const code = await provider.getCode(address);
  return code !== '0x' && code !== '0x0';
}

/* ── Public API ─────────────────────────────────────────────────────────── */

export interface HotWalletBalances {
  address: string;
  usdt:    string; // human-readable, e.g. "1234.56"
  bnb:     string; // human-readable, e.g. "0.0312"
}

/**
 * Returns current USDT and BNB balances of the hot wallet.
 * Used by the admin monitoring route.
 */
export async function getHotWalletBalances(): Promise<HotWalletBalances> {
  const wallet   = getHotWallet();
  const provider = getProvider();
  const contract = new ethers.Contract(env.USDT_BSC_CONTRACT, ERC20_ABI, provider);

  const [usdtRaw, bnbRaw]: [bigint, bigint] = await Promise.all([
    contract.balanceOf(wallet.address) as Promise<bigint>,
    provider.getBalance(wallet.address),
  ]);

  return {
    address: wallet.address,
    usdt:    ethers.formatUnits(usdtRaw, 18),
    bnb:     ethers.formatEther(bnbRaw),
  };
}

export interface SendUsdtParams {
  to:     string; // destination BSC address
  amount: number; // gross amount in USDT (human-readable, e.g. 10.5)
}

export interface SendUsdtResult {
  txHash: string;
}

/**
 * Sends `amount` USDT from the hot wallet to `to` on BSC.
 *
 * Throws:
 *  - 'INVALID_ADDRESS'                if `to` is not a valid EVM address
 *  - 'INSUFFICIENT_HOT_WALLET_BALANCE' if hot wallet USDT < amount
 *  - 'INSUFFICIENT_GAS'               if hot wallet BNB < BNB_GAS_MIN
 */
export async function sendUsdt({ to, amount }: SendUsdtParams): Promise<SendUsdtResult> {
  /* 1. Validate destination address */
  if (!ethers.isAddress(to)) {
    throw new Error('INVALID_ADDRESS');
  }

  const wallet   = getHotWallet();
  const contract = new ethers.Contract(env.USDT_BSC_CONTRACT, ERC20_ABI, wallet);
  const provider = wallet.provider!;

  const amountWei = ethers.parseUnits(amount.toString(), 18);

  /* 2. Check USDT balance */
  const usdtBalance = (await contract.balanceOf(wallet.address)) as bigint;
  if (usdtBalance < amountWei) {
    throw new Error('INSUFFICIENT_HOT_WALLET_BALANCE');
  }

  /* 3. Check BNB for gas */
  const bnbBalance = await provider.getBalance(wallet.address);
  if (bnbBalance < BNB_GAS_MIN) {
    throw new Error('INSUFFICIENT_GAS');
  }

  /* 4. Execute transfer — wait for 1 confirmation */
  const tx      = await (contract.transfer(to, amountWei) as Promise<ethers.TransactionResponse>);
  const receipt = await tx.wait(1);

  if (!receipt) throw new Error('Transaction receipt not received');

  return { txHash: receipt.hash };
}
