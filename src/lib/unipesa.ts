/**
 * UniPay ↔ Unipesa aggregator bridge.
 *
 * Adapted from Congo Gaming's server/lib/unipesa.ts.
 * Uses the same HMAC-SHA-512 signature scheme and the Fixie static-IP
 * proxy so requests leave Render from a whitelisted IP.
 *
 * Supported currencies: USD (via depositUSD / withdrawUSD).
 * CDF flows are handled by the existing Avada/operator services.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { env } from '../config/env';

const BASE = 'https://api.unipesa.tech';

const PROXY_URL = env.FIXIE_URL;
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;
const fetchWithProxy: typeof fetch = proxyAgent
  ? ((url: any, opts: any) =>
      undiciFetch(url, { ...(opts ?? {}), dispatcher: proxyAgent }) as any)
  : fetch;

/** Maps mobile-money operator slug to the Unipesa numeric provider_id (CDF flows). */
export const UNIPESA_PROVIDER_IDS: Record<string, number> = {
  orange:    1,
  airtel:    2,
  afrimoney: 3,
  mpesa:     4,
};

/**
 * Maps mobile-money operator slug to the Unipesa numeric provider_id for USD flows.
 * USD providers have different IDs from their CDF equivalents.
 *   Orange USD  → 10
 *   Airtel USD  → 17
 *   Africell USD → 19
 */
export const UNIPESA_USD_PROVIDER_IDS: Record<string, number> = {
  orange:   10,
  airtel:   17,
  africell: 19,
};

export type UnipesaResponse = {
  status?: number;
  transaction_id?: string;
  message?: string;
  [k: string]: any;
};

/**
 * Build the Unipesa request signature (HMAC-SHA-512 over sorted key=value pairs).
 * The `signature` key itself is excluded from the digest.
 */
export function calculateSignature(data: Record<string, any>, secretKey: string): string {
  let s = '';
  for (const [key, value] of Object.entries(data)) {
    if (key === 'signature') continue;
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, any>)) {
        s += `${key}.${k}${v}`;
      }
    } else {
      s += `${key}${value}`;
    }
  }
  return createHmac('sha512', secretKey).update(s).digest('hex').toLowerCase();
}

async function call(
  path: string,
  payload: Record<string, any>,
  signal?: AbortSignal,
): Promise<UnipesaResponse> {
  const publicId = env.UNIPESA_PUBLIC_ID;
  if (!publicId) throw new Error('UNIPESA_PUBLIC_ID not configured');
  const url = `${BASE}/${publicId}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(30_000);
  const res = await fetchWithProxy(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: effectiveSignal,
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Unipesa ${res.status}: ${json?.message ?? text}`);
    (err as any).response = json;
    throw err;
  }
  return json;
}

export function newOrderId(): string {
  return randomUUID();
}

/**
 * C2B — collect USD from a subscriber's mobile money into UniPay.
 * `customer_id` is the subscriber's full phone number (e.g. +243XXXXXXXXX).
 */
export async function depositUSD(
  opts: { order_id: string; customer_id: string; amount: number; provider_id: number },
  signal?: AbortSignal,
): Promise<UnipesaResponse> {
  const { UNIPESA_MERCHANT_ID: merchant_id, UNIPESA_CALLBACK_URL: callback_url, UNIPESA_SECRET_KEY: secret } = env;
  if (!merchant_id || !callback_url || !secret) throw new Error('Unipesa not fully configured');
  const payload: Record<string, any> = {
    merchant_id,
    customer_id:  opts.customer_id,
    order_id:     opts.order_id,
    amount:       opts.amount,
    currency:     'USD',
    country:      'CD',
    callback_url,
    provider_id:  opts.provider_id,
  };
  payload.signature = calculateSignature(payload, secret);
  return call('/payment_c2b', payload, signal);
}

/**
 * B2C — pay out USD from UniPay to a subscriber's mobile money.
 */
export async function withdrawUSD(
  opts: { order_id: string; customer_id: string; amount: number; provider_id: number },
  signal?: AbortSignal,
): Promise<UnipesaResponse> {
  const { UNIPESA_MERCHANT_ID: merchant_id, UNIPESA_CALLBACK_URL: callback_url, UNIPESA_SECRET_KEY: secret } = env;
  if (!merchant_id || !callback_url || !secret) throw new Error('Unipesa not fully configured');
  const payload: Record<string, any> = {
    merchant_id,
    customer_id:  opts.customer_id,
    order_id:     opts.order_id,
    amount:       opts.amount,
    currency:     'USD',
    country:      'CD',
    callback_url,
    provider_id:  opts.provider_id,
  };
  payload.signature = calculateSignature(payload, secret);
  return call('/payment_b2c', payload, signal);
}

/**
 * Verify that a callback body has a valid Unipesa signature.
 * Always returns false when UNIPESA_SECRET_KEY is not set.
 */
export function verifyCallbackSignature(body: Record<string, any>): boolean {
  const secret = env.UNIPESA_SECRET_KEY;
  if (!secret) return false;
  const provided = String(body?.signature ?? '');
  if (!provided) return false;
  const expected = calculateSignature(body, secret);
  return provided.toLowerCase() === expected.toLowerCase();
}
