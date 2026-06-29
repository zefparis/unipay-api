/**
 * Binance REST API — USDT withdrawal helper.
 * Pure Node.js, no SDK.  Only the minimum endpoints needed.
 *
 * Docs:
 *   POST /sapi/v1/capital/withdraw/apply  — submit withdrawal
 *   GET  /sapi/v1/capital/withdraw/history — poll status
 */
/** Network names expected by Binance for each chain. */
declare const NETWORK_MAP: Record<'BSC' | 'TRC20' | 'ERC20', string>;
export type WithdrawNetwork = keyof typeof NETWORK_MAP;
export interface WithdrawUsdtOptions {
    amount: number;
    network: WithdrawNetwork;
    address: string;
    apiKey: string;
    secretKey: string;
}
export interface WithdrawUsdtResult {
    id: string;
    success: boolean;
}
/**
 * POST /sapi/v1/capital/withdraw/apply
 * Submits a USDT withdrawal to the given address on the specified network.
 * The `amount` passed here must already be net of fee.
 */
export declare function withdrawUsdt(opts: WithdrawUsdtOptions): Promise<WithdrawUsdtResult>;
export type BinanceWithdrawStatus = 'email_sent' | 'cancelled' | 'awaiting_approval' | 'rejected' | 'processing' | 'failure' | 'completed' | 'unknown';
export interface WithdrawStatusResult {
    status: BinanceWithdrawStatus;
    txHash?: string;
}
/**
 * GET /sapi/v1/capital/withdraw/history
 * Fetches the latest status for a given Binance withdrawId.
 */
export declare function getWithdrawStatus(withdrawId: string, apiKey: string, secretKey: string): Promise<WithdrawStatusResult>;
export {};
