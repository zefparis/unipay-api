/**
 * ADI Chain hot-wallet USDC withdrawal service.
 *
 * Sends USDC ERC-20 directly on-chain from the UniPay settlement wallet.
 * USDC on ADI Chain uses 6 decimals (standard USDC precision).
 * Chain ID: 36900 — RPC: https://rpc.adifoundation.ai
 */
import { ethers } from 'ethers';
export interface AdiWalletBalances {
    address: string;
    usdc: string;
    adi: string;
}
/**
 * Returns current USDC and ADI native balances of the settlement wallet.
 * Used by the admin monitoring route.
 */
export declare function getAdiWalletBalances(): Promise<AdiWalletBalances>;
export interface SendUsdcParams {
    to: string;
    amount: number;
}
export interface SendUsdcResult {
    txHash: string;
}
/**
 * Sends `amount` USDC from the settlement wallet to `to` on ADI Chain.
 *
 * Throws:
 *  - 'INVALID_ADDRESS'                 if `to` is not a valid EVM address
 *  - 'INSUFFICIENT_HOT_WALLET_BALANCE' if wallet USDC < amount
 *  - 'INSUFFICIENT_GAS'                if wallet ADI native < ADI_GAS_MIN
 */
export declare function sendUsdc({ to, amount }: SendUsdcParams): Promise<SendUsdcResult>;
/**
 * Polls the chain until `txHash` has at least `confirmations` blocks on top.
 * Returns true when confirmed, false on timeout (max 120s).
 */
export declare function waitForConfirmations(txHash: string, confirmations?: number): Promise<boolean>;
/**
 * Fetches the raw transaction receipt from the ADI Chain RPC.
 * Returns null if the transaction is not yet indexed.
 */
export declare function getAdiTransactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null>;
