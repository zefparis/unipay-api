/**
 * Binance REST API — admin-level helpers.
 * Pure Node.js, no SDK.
 *
 * Docs:
 *   GET  /api/v3/account                    — main account balances
 *   GET  /sapi/v3/sub-account/assets        — sub-account balances
 *   POST /sapi/v1/capital/withdraw/apply    — withdrawal (reused from binance-withdrawal.ts)
 *   GET  /sapi/v1/capital/withdraw/history  — withdrawal history
 */
import { withdrawUsdt } from './binance-withdrawal.js';
export { withdrawUsdt };
export interface AssetBalance {
    asset: string;
    free: string;
    locked: string;
}
export interface WithdrawRecord {
    id: string;
    amount: string;
    coin: string;
    network: string;
    address: string;
    txId: string | null;
    status: number;
    applyTime: string;
    transferType: number;
}
/**
 * GET /api/v3/account
 * Returns only assets with free > 0.
 */
export declare function getAccountBalance(apiKey: string, secretKey: string): Promise<AssetBalance[]>;
/**
 * GET /sapi/v3/sub-account/assets
 * Returns balances for the given sub-account email.
 */
export declare function getSubAccountBalance(email: string, mainApiKey: string, mainSecretKey: string): Promise<AssetBalance[]>;
/**
 * GET /sapi/v1/capital/withdraw/history
 * Returns last `limit` USDT withdrawals.
 */
export declare function getWithdrawHistory(apiKey: string, secretKey: string, limit?: number): Promise<WithdrawRecord[]>;
