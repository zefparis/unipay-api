/**
 * BSC hot-wallet USDT withdrawal service.
 *
 * Sends USDT BEP-20 directly on-chain from the UniPay hot wallet.
 * USDT on BSC uses 18 decimals (not 6 like on Ethereum/Tron).
 */
/**
 * Returns true if `address` is a smart contract (has bytecode), false if it's
 * an EOA (externally owned account). Uses eth_getCode which returns '0x' for
 * plain wallets and non-empty hex for any contract.
 */
export declare function isContractAddress(address: string): Promise<boolean>;
export interface HotWalletBalances {
    address: string;
    usdt: string;
    bnb: string;
}
/**
 * Returns current USDT and BNB balances of the hot wallet.
 * Used by the admin monitoring route.
 */
export declare function getHotWalletBalances(): Promise<HotWalletBalances>;
export interface SendUsdtParams {
    to: string;
    amount: number;
}
export interface SendUsdtResult {
    txHash: string;
}
export declare class OnchainConfirmationPendingError extends Error {
    readonly txHash: string;
    constructor(txHash: string, cause?: unknown);
}
export declare class OnchainExecutionFailedError extends Error {
    readonly txHash: string;
    constructor(txHash: string, cause?: unknown);
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
export declare function sendUsdt({ to, amount }: SendUsdtParams): Promise<SendUsdtResult>;
export declare function verifyUsdtWithdrawal(txHash: string, recipient: string, amount: number): Promise<OnchainTransferStatus>;
export declare function verifyWcgltMint(txHash: string, recipient: string, amount: number): Promise<OnchainTransferStatus>;
