/**
 * Pure ADI Chain token-transfer verification logic.
 *
 * Parses an EVM transaction receipt (from eth_getTransactionReceipt) and
 * determines whether a specific ERC-20 transfer occurred:
 *   – correct token contract (USDC on ADI Chain)
 *   – correct recipient address
 *   – amount matches expected_amount (or received_amount when provided)
 *
 * This module has NO side-effects, NO HTTP calls, NO Supabase dependencies —
 * it exists purely so it can be unit-tested without mocking infrastructure.
 */
export declare const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export declare const ADI_TOKEN_CONTRACTS: Record<string, string>;
export declare const ADI_TOKEN_DECIMALS: Record<string, number>;
export declare const ADI_RPC_URL = "https://rpc.adifoundation.ai";
export declare const ADI_CHAIN_ID = 36900;
export interface EthTxLog {
    address: string;
    topics: string[];
    data: string;
}
export interface EthTxReceipt {
    logs: EthTxLog[];
    /**
     * EVM receipt status — may return any of:
     *   "0x1" | "0x0"  (standard JSON-RPC hex)
     *   "1"   | "0"    (decimal string)
     *    1    |  0     (number)
     * Use isTxSuccess() / isTxFailed() instead of direct equality.
     */
    status: string | number;
}
/** Normalize any RPC status representation to boolean success. */
export declare function isTxSuccess(status: string | number): boolean;
export declare function isTxFailed(status: string | number): boolean;
export type BlockingReason = 'TX_FAILED' | 'CONTRACT_MISMATCH' | 'NO_TRANSFER_LOG' | 'RECIPIENT_MISMATCH' | 'AMOUNT_MISMATCH' | 'TX_NOT_INDEXED' | 'BSCSCAN_ERROR';
export interface AdiVerifyResult {
    verified: boolean;
    is_on_chain: boolean;
    tx_success: boolean;
    contract_match: boolean;
    recipient_match: boolean;
    amount_match: boolean;
    transferred_amount: number | null;
    expected_amount: number;
    asset: string;
    blocking_reasons: BlockingReason[];
    reason: string;
}
/**
 * Decode an address from a 32-byte padded topic or data slot.
 * Input: "0x000000000000000000000000<40-char-hex-address>"
 * Output: "0x<40-char-hex-address>" (lowercase)
 */
export declare function decodeAddress(padded: string): string;
/**
 * Decode a uint256 from a 32-byte data field into a JS number scaled by decimals.
 * NOTE: BigInt is used to avoid precision loss on large values before scaling.
 */
export declare function decodeUint256(data: string, decimals: number): number;
/**
 * Verify that an ADI Chain transaction receipt contains the expected ERC-20 Transfer.
 *
 * @param receipt           Raw result from eth_getTransactionReceipt
 * @param asset             "USDC"
 * @param receivingAddress  Treasury receiving address (EVM, checksummed or lower)
 * @param expectedAmount    Amount to verify against (received_amount if set, else expected_amount)
 */
export declare function verifyAdiTransfer(receipt: EthTxReceipt, asset: string, receivingAddress: string, expectedAmount: number): AdiVerifyResult;
