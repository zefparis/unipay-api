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

/* ── ERC-20 Transfer(address,address,uint256) keccak-256 topic ─────── */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/* ── ADI Chain token contract (checksummed) ──────────────────────────── */
export const ADI_TOKEN_CONTRACTS: Record<string, string> = {
  USDC: '0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2',
};

/* ── USDC has 6 decimals on ADI Chain ───────────────────────────────── */
export const ADI_TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
};

/* ── ADI Chain network constants ─────────────────────────────────────── */
export const ADI_RPC_URL  = 'https://rpc.adifoundation.ai';
export const ADI_CHAIN_ID = 36900;

/* ── Amount tolerance: 6 decimals → higher precision ────────────────── */
const AMOUNT_TOLERANCE = 0.001;

/* ── Types ───────────────────────────────────────────────────────────── */
export interface EthTxLog {
  address: string;   // contract that emitted the event
  topics:  string[]; // [eventSig, ...indexed params]
  data:    string;   // abi-encoded non-indexed params (hex)
}

export interface EthTxReceipt {
  logs:   EthTxLog[];
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
export function isTxSuccess(status: string | number): boolean {
  return status === '0x1' || status === 1 || status === '1';
}

export function isTxFailed(status: string | number): boolean {
  return status === '0x0' || status === 0 || status === '0';
}

export type BlockingReason =
  | 'TX_FAILED'
  | 'CONTRACT_MISMATCH'
  | 'NO_TRANSFER_LOG'
  | 'RECIPIENT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'TX_NOT_INDEXED'
  | 'BSCSCAN_ERROR';

export interface AdiVerifyResult {
  verified:           boolean;
  is_on_chain:        boolean;
  tx_success:         boolean;
  contract_match:     boolean;
  recipient_match:    boolean;
  amount_match:       boolean;
  transferred_amount: number | null;
  expected_amount:    number;
  asset:              string;
  blocking_reasons:   BlockingReason[];
  reason:             string;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Decode an address from a 32-byte padded topic or data slot.
 * Input: "0x000000000000000000000000<40-char-hex-address>"
 * Output: "0x<40-char-hex-address>" (lowercase)
 */
export function decodeAddress(padded: string): string {
  const hex = padded.startsWith('0x') ? padded.slice(2) : padded;
  return '0x' + hex.slice(-40).toLowerCase();
}

/**
 * Decode a uint256 from a 32-byte data field into a JS number scaled by decimals.
 * NOTE: BigInt is used to avoid precision loss on large values before scaling.
 */
export function decodeUint256(data: string, decimals: number): number {
  const hex = data.startsWith('0x') ? data : '0x' + data;
  const raw = BigInt(hex);
  // Divide by 10^decimals using integer arithmetic up to the decimal boundary
  const divisor  = BigInt(10 ** decimals);
  const whole    = raw / divisor;
  const fraction = raw % divisor;
  return Number(whole) + Number(fraction) / 10 ** decimals;
}

/* ── Main export ─────────────────────────────────────────────────────── */

/**
 * Verify that an ADI Chain transaction receipt contains the expected ERC-20 Transfer.
 *
 * @param receipt           Raw result from eth_getTransactionReceipt
 * @param asset             "USDC"
 * @param receivingAddress  Treasury receiving address (EVM, checksummed or lower)
 * @param expectedAmount    Amount to verify against (received_amount if set, else expected_amount)
 */
export function verifyAdiTransfer(
  receipt:          EthTxReceipt,
  asset:            string,
  receivingAddress: string,
  expectedAmount:   number,
): AdiVerifyResult {
  const blockingReasons: BlockingReason[] = [];

  /* ── 1. Transaction success ───────────────────────────────────────── */
  const txSuccess = isTxSuccess(receipt.status);
  if (!txSuccess) {
    blockingReasons.push('TX_FAILED');
    return {
      verified:           false,
      is_on_chain:        true,
      tx_success:         false,
      contract_match:     false,
      recipient_match:    false,
      amount_match:       false,
      transferred_amount: null,
      expected_amount:    expectedAmount,
      asset,
      blocking_reasons:   blockingReasons,
      reason:             `Transaction reverted on-chain (status=${String(receipt.status)})`,
    };
  }

  const contractAddress = ADI_TOKEN_CONTRACTS[asset];
  if (!contractAddress) {
    blockingReasons.push('CONTRACT_MISMATCH');
    return {
      verified:           false,
      is_on_chain:        true,
      tx_success:         true,
      contract_match:     false,
      recipient_match:    false,
      amount_match:       false,
      transferred_amount: null,
      expected_amount:    expectedAmount,
      asset,
      blocking_reasons:   blockingReasons,
      reason:             `Unsupported asset '${asset}' — no known ADI Chain contract`,
    };
  }

  const decimals   = ADI_TOKEN_DECIMALS[asset] ?? 6;
  const targetAddr = receivingAddress.toLowerCase();
  const targetCtr  = contractAddress.toLowerCase();

  /* ── 2. Find Transfer logs for this contract ─────────────────────── */
  const transferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === targetCtr &&
      log.topics.length === 3 &&
      log.topics[0].toLowerCase() === TRANSFER_TOPIC,
  );

  if (transferLogs.length === 0) {
    blockingReasons.push('NO_TRANSFER_LOG');
    return {
      verified:           false,
      is_on_chain:        true,
      tx_success:         true,
      contract_match:     false,
      recipient_match:    false,
      amount_match:       false,
      transferred_amount: null,
      expected_amount:    expectedAmount,
      asset,
      blocking_reasons:   blockingReasons,
      reason:             `No ${asset} Transfer event found in this transaction (wrong contract or token)`,
    };
  }

  /* ── 3. Find log matching the recipient address ──────────────────── */
  const matchingLog = transferLogs.find(
    (log) => decodeAddress(log.topics[2]) === targetAddr,
  );

  if (!matchingLog) {
    const found = transferLogs.map((log) => decodeAddress(log.topics[2]));
    blockingReasons.push('RECIPIENT_MISMATCH');
    return {
      verified:           false,
      is_on_chain:        true,
      tx_success:         true,
      contract_match:     true,
      recipient_match:    false,
      amount_match:       false,
      transferred_amount: null,
      expected_amount:    expectedAmount,
      asset,
      blocking_reasons:   blockingReasons,
      reason:             `No ${asset} transfer to ${receivingAddress}. Recipients found: ${found.join(', ')}`,
    };
  }

  /* ── 4. Decode and compare amount ────────────────────────────────── */
  const transferred = decodeUint256(matchingLog.data, decimals);
  const amountOk    = Math.abs(transferred - expectedAmount) <= AMOUNT_TOLERANCE;

  if (!amountOk) {
    blockingReasons.push('AMOUNT_MISMATCH');
  }

  return {
    verified:           blockingReasons.length === 0,
    is_on_chain:        true,
    tx_success:         true,
    contract_match:     true,
    recipient_match:    true,
    amount_match:       amountOk,
    transferred_amount: transferred,
    expected_amount:    expectedAmount,
    asset,
    blocking_reasons:   blockingReasons,
    reason:             blockingReasons.length === 0
      ? 'OK'
      : `Amount mismatch: on-chain transfer was ${transferred} ${asset}, expected ${expectedAmount} ${asset}`,
  };
}
