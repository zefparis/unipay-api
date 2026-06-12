/**
 * Binance REST API — USDT withdrawal helper.
 * Pure Node.js, no SDK.  Only the minimum endpoints needed.
 *
 * Docs:
 *   POST /sapi/v1/capital/withdraw/apply  — submit withdrawal
 *   GET  /sapi/v1/capital/withdraw/history — poll status
 */

import crypto from 'node:crypto';

const BINANCE_BASE = 'https://api.binance.com';

/** Network names expected by Binance for each chain. */
const NETWORK_MAP: Record<'BSC' | 'TRC20' | 'ERC20', string> = {
  BSC:   'BSC',
  TRC20: 'TRX',
  ERC20: 'ETH',
};

export type WithdrawNetwork = keyof typeof NETWORK_MAP;

/** HMAC-SHA256 signature required by Binance signed endpoints. */
function signRequest(queryString: string, secretKey: string): string {
  return crypto
    .createHmac('sha256', secretKey)
    .update(queryString)
    .digest('hex');
}

/** Build a signed query string with timestamp + signature appended. */
function buildSignedQS(params: Record<string, string | number>, secretKey: string): string {
  const ts = Date.now();
  const base = Object.entries({ ...params, timestamp: ts })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const sig = signRequest(base, secretKey);
  return `${base}&signature=${sig}`;
}

export interface WithdrawUsdtOptions {
  amount:    number;
  network:   WithdrawNetwork;
  address:   string;
  apiKey:    string;
  secretKey: string;
}

export interface WithdrawUsdtResult {
  id:      string; // Binance withdrawId
  success: boolean;
}

/**
 * POST /sapi/v1/capital/withdraw/apply
 * Submits a USDT withdrawal to the given address on the specified network.
 * The `amount` passed here must already be net of fee.
 */
export async function withdrawUsdt(opts: WithdrawUsdtOptions): Promise<WithdrawUsdtResult> {
  const { amount, network, address, apiKey, secretKey } = opts;
  const binanceNetwork = NETWORK_MAP[network];

  const qs = buildSignedQS(
    {
      coin:    'USDT',
      network: binanceNetwork,
      address,
      amount:  amount.toFixed(6),
    },
    secretKey,
  );

  const res = await fetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/apply`, {
    method:  'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: qs,
  });

  const json = (await res.json()) as { id?: string; msg?: string; code?: number };

  if (!res.ok || !json.id) {
    throw new Error(
      `Binance withdrawal failed [${res.status}]: ${json.msg ?? JSON.stringify(json)}`,
    );
  }

  return { id: json.id, success: true };
}

export type BinanceWithdrawStatus =
  | 'email_sent'
  | 'cancelled'
  | 'awaiting_approval'
  | 'rejected'
  | 'processing'
  | 'failure'
  | 'completed'
  | 'unknown';

const STATUS_MAP: Record<number, BinanceWithdrawStatus> = {
  0: 'email_sent',
  1: 'cancelled',
  2: 'awaiting_approval',
  3: 'rejected',
  4: 'processing',
  5: 'failure',
  6: 'completed',
};

export interface WithdrawStatusResult {
  status:  BinanceWithdrawStatus;
  txHash?: string;
}

/**
 * GET /sapi/v1/capital/withdraw/history
 * Fetches the latest status for a given Binance withdrawId.
 */
export async function getWithdrawStatus(
  withdrawId: string,
  apiKey:     string,
  secretKey:  string,
): Promise<WithdrawStatusResult> {
  const qs  = buildSignedQS({ withdrawOrderId: withdrawId, limit: 10 }, secretKey);
  const res = await fetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/history?${qs}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });

  const list = (await res.json()) as Array<{ id: string; status: number; txId?: string }>;

  if (!res.ok || !Array.isArray(list)) {
    return { status: 'unknown' };
  }

  const record = list.find(r => r.id === withdrawId);
  if (!record) return { status: 'unknown' };

  return {
    status:  STATUS_MAP[record.status] ?? 'unknown',
    txHash:  record.txId ?? undefined,
  };
}
