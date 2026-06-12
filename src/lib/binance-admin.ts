/**
 * Binance REST API — admin-level helpers.
 * Pure Node.js, no SDK.
 *
 * Docs:
 *   GET  /api/v3/account                    — main account balances
 *   GET  /sapi/v1/sub-account/assets        — sub-account balances
 *   POST /sapi/v1/capital/withdraw/apply    — withdrawal (reused from binance-withdrawal.ts)
 *   GET  /sapi/v1/capital/withdraw/history  — withdrawal history
 */

import crypto from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { env } from '../config/env.js';
import { withdrawUsdt } from './binance-withdrawal.js';

export { withdrawUsdt };

const BINANCE_BASE = 'https://api.binance.com';

/* ── Fixie proxy ──────────────────────────────────────────────────────── */

let _proxyAgent: ProxyAgent | undefined;
function getProxyAgent(): ProxyAgent | undefined {
  if (!env.FIXIE_URL) return undefined;
  if (!_proxyAgent) _proxyAgent = new ProxyAgent(env.FIXIE_URL);
  return _proxyAgent;
}

async function binanceFetch(url: string, opts: Record<string, unknown> = {}): Promise<Response> {
  const dispatcher = getProxyAgent();
  return undiciFetch(url, {
    ...opts,
    ...(dispatcher ? { dispatcher } : {}),
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
}

/* ── HMAC helpers ─────────────────────────────────────────────────────── */

function signRequest(queryString: string, secretKey: string): string {
  return crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
}

function buildSignedQS(params: Record<string, string | number>, secretKey: string): string {
  const base = Object.entries({ ...params, timestamp: Date.now() })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}&signature=${signRequest(base, secretKey)}`;
}

/* ── Types ────────────────────────────────────────────────────────────── */

export interface AssetBalance {
  asset:  string;
  free:   string;
  locked: string;
}

export interface WithdrawRecord {
  id:             string;
  amount:         string;
  coin:           string;
  network:        string;
  address:        string;
  txId:           string | null;
  status:         number;
  applyTime:      string;
  transferType:   number;
}

/* ── 1. Main account balances ─────────────────────────────────────────── */

/**
 * GET /api/v3/account
 * Returns only assets with free > 0.
 */
export async function getAccountBalance(
  apiKey:    string,
  secretKey: string,
): Promise<AssetBalance[]> {
  const qs  = buildSignedQS({}, secretKey);
  const res = await binanceFetch(`${BINANCE_BASE}/api/v3/account?${qs}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });

  if (!res.ok) {
    const err = (await res.json()) as { msg?: string };
    throw new Error(`Binance account [${res.status}]: ${err.msg ?? res.statusText}`);
  }

  const json = (await res.json()) as { balances: AssetBalance[] };
  return (json.balances ?? []).filter(b => parseFloat(b.free) > 0);
}

/* ── 2. Sub-account balances ──────────────────────────────────────────── */

/**
 * GET /sapi/v1/sub-account/assets
 * Returns balances for the given sub-account email.
 */
export async function getSubAccountBalance(
  email:          string,
  mainApiKey:     string,
  mainSecretKey:  string,
): Promise<AssetBalance[]> {
  const qs  = buildSignedQS({ email }, mainSecretKey);
  const res = await binanceFetch(`${BINANCE_BASE}/sapi/v1/sub-account/assets?${qs}`, {
    headers: { 'X-MBX-APIKEY': mainApiKey },
  });

  if (!res.ok) {
    const err = (await res.json()) as { msg?: string };
    throw new Error(`Binance sub-account [${res.status}]: ${err.msg ?? res.statusText}`);
  }

  const json = (await res.json()) as { balances: AssetBalance[] };
  return (json.balances ?? []).filter(b => parseFloat(b.free) > 0);
}

/* ── 3. Withdrawal history ────────────────────────────────────────────── */

/**
 * GET /sapi/v1/capital/withdraw/history
 * Returns last `limit` USDT withdrawals.
 */
export async function getWithdrawHistory(
  apiKey:    string,
  secretKey: string,
  limit      = 50,
): Promise<WithdrawRecord[]> {
  const qs  = buildSignedQS({ coin: 'USDT', limit }, secretKey);
  const res = await binanceFetch(`${BINANCE_BASE}/sapi/v1/capital/withdraw/history?${qs}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });

  if (!res.ok) {
    const err = (await res.json()) as { msg?: string };
    throw new Error(`Binance withdraw history [${res.status}]: ${err.msg ?? res.statusText}`);
  }

  return (await res.json()) as WithdrawRecord[];
}
