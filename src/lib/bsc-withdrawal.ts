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
  'event Transfer(address indexed from, address indexed to, uint256 value)',
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
  if (!env.USDT_BSC_CONTRACT) {
    throw new Error('USDT_BSC_CONTRACT not configured');
  }
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

export class OnchainConfirmationPendingError extends Error {
  constructor(public readonly txHash: string, cause?: unknown) {
    super('PENDING_ONCHAIN_CHECK', { cause });
    this.name = 'OnchainConfirmationPendingError';
  }
}

export class OnchainExecutionFailedError extends Error {
  constructor(public readonly txHash: string, cause?: unknown) {
    super('ONCHAIN_EXECUTION_FAILED', { cause });
    this.name = 'OnchainExecutionFailedError';
  }
}

export type OnchainTransferStatus = 'pending' | 'confirmed' | 'failed' | 'mismatch';

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
  if (!env.USDT_BSC_CONTRACT) {
    throw new Error('USDT_BSC_CONTRACT not configured');
  }
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
  const tx = await (contract.transfer(to, amountWei) as Promise<ethers.TransactionResponse>);
  try {
    const receipt = await tx.wait(1);
    if (!receipt) throw new OnchainConfirmationPendingError(tx.hash);
    if (receipt.status !== 1) throw new OnchainExecutionFailedError(tx.hash);
    return { txHash: receipt.hash };
  } catch (err) {
    if (err instanceof OnchainConfirmationPendingError || err instanceof OnchainExecutionFailedError) throw err;
    const receipt = (err as { receipt?: { status?: number; hash?: string } })?.receipt;
    if (receipt?.status === 0) throw new OnchainExecutionFailedError(receipt.hash ?? tx.hash, err);
    if (receipt?.status === 1) return { txHash: receipt.hash ?? tx.hash };
    throw new OnchainConfirmationPendingError(tx.hash, err);
  }
}

async function verifyTransfer(
  txHash: string,
  contractAddress: string,
  expectedFrom: string,
  expectedTo: string,
  expectedAmount: bigint,
): Promise<OnchainTransferStatus> {
  const provider = getProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return 'pending';
  if (receipt.status !== 1) return 'failed';

  const iface = new ethers.Interface(ERC20_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (
        parsed?.name === 'Transfer' &&
        String(parsed.args[0]).toLowerCase() === expectedFrom.toLowerCase() &&
        String(parsed.args[1]).toLowerCase() === expectedTo.toLowerCase() &&
        BigInt(parsed.args[2]) === expectedAmount
      ) {
        return 'confirmed';
      }
    } catch {
      continue;
    }
  }
  return 'mismatch';
}

export async function verifyUsdtWithdrawal(
  txHash: string,
  recipient: string,
  amount: number,
): Promise<OnchainTransferStatus> {
  if (!env.USDT_BSC_CONTRACT) throw new Error('USDT_BSC_CONTRACT not configured');
  const wallet = getHotWallet();
  return verifyTransfer(
    txHash,
    env.USDT_BSC_CONTRACT,
    wallet.address,
    recipient,
    ethers.parseUnits(amount.toString(), 18),
  );
}

export async function verifyWcgltMint(
  txHash: string,
  recipient: string,
  amount: number,
): Promise<OnchainTransferStatus> {
  if (!env.BSC_WCGLT_ADDRESS) throw new Error('BSC_WCGLT_ADDRESS not configured');
  return verifyTransfer(
    txHash,
    env.BSC_WCGLT_ADDRESS,
    ethers.ZeroAddress,
    recipient,
    ethers.parseUnits(amount.toString(), 18),
  );
}
