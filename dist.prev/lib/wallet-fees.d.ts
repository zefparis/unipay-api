/**
 * Wallet (grand public) fee rate — deposit and withdraw.
 * Single source of truth: env WALLET_FEE_RATE, default 0.05 = 5%.
 * The Avada/Unipesa provider cost (3%) is internal-only and must
 * never appear in user-facing output.
 */
export declare const WALLET_FEE_RATE: number;
export declare function walletFee(amount: number): number;
