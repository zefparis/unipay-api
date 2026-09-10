import crypto from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { env } from '../config/env';
import { normalizePhoneForOperator } from '../lib/phone-normalization';

const BASE = 'https://api.unipesa.tech';

// AvadaPay provider IDs (same as congogaming)
const PROVIDER_IDS: Record<string, number> = {
  orange:    10,
  airtel:    17,
  afrimoney: 19,
};

export type AvadaOperator = 'Orange' | 'Airtel' | 'Afrimoney';
export type AvadaStatus = 'pending' | 'processing' | 'success' | 'failed' | 'cancelled';

// Real Unipesa callback payload shape
export interface AvadaCallbackPayload {
  order_id: string;       // = our reference (WD-XXXXXXXX)
  transaction_id: string; // Unipesa internal ID
  status: number;         // 0=pending,1=processing,2=success,3=failed
  customer_id: string;    // phone number
  provider_id: number;    // 10=Orange,17=Airtel,19=Afrimoney
  amount: number;
  currency?: string;
  merchant_id?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface NormalizedCallback {
  avada_transaction_id: string;
  reference: string;
  status: AvadaStatus;
  operator: string;
  amount: number;
  phone: string;
  raw: AvadaCallbackPayload;
}

const CALLBACK_STATUS_MAP: Record<number, AvadaStatus> = {
  0: 'pending',
  1: 'processing',
  2: 'success',
  3: 'failed',
};

const CALLBACK_PROVIDER_MAP: Record<number, string> = {
  10: 'orange',
  17: 'airtel',
  19: 'afrimoney',
};

export interface UnipesaBalance {
  balance: number;
  currency: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireUnipesaEnv(): { publicId: string; merchantId: string; secretKey: string; callbackUrl: string } {
  const publicId    = env.UNIPESA_PUBLIC_ID;
  const merchantId  = env.UNIPESA_MERCHANT_ID;
  const secretKey   = env.UNIPESA_SECRET_KEY;
  // Merchant flow uses a dedicated callback URL (/v1/payment/callback).
  // Fall back to UNIPESA_CALLBACK_URL for backward compatibility.
  const callbackUrl = env.UNIPESA_MERCHANT_CALLBACK_URL ?? env.UNIPESA_CALLBACK_URL;
  if (!publicId || !merchantId || !secretKey || !callbackUrl) {
    throw new Error(
      'Unipesa integration not configured: UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID, UNIPESA_SECRET_KEY, UNIPESA_MERCHANT_CALLBACK_URL (or UNIPESA_CALLBACK_URL) required',
    );
  }
  return { publicId, merchantId, secretKey, callbackUrl };
}

// HMAC-SHA512 signature — same algorithm as congogaming/AvadaPay spec
function calculateSignature(data: Record<string, unknown>, secretKey: string): string {
  let str = '';
  for (const [key, value] of Object.entries(data)) {
    if (key === 'signature') continue;
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        str += `${key}.${k}${v}`;
      }
    } else {
      str += `${key}${value}`;
    }
  }
  return crypto.createHmac('sha512', secretKey).update(str).digest('hex').toLowerCase();
}

let _proxyAgent: ProxyAgent | undefined;
let _skipWarned = false;

function isSkipFixieCheck(): boolean {
  const v = env.UNIPESA_SKIP_FIXIE_CHECK;
  return v === '1' || v === 'true';
}

function getProxyAgent(): ProxyAgent | undefined {
  if (!env.FIXIE_URL) {
    // Hard block: no payment may leave without a Fixie proxy unless an
    // explicit, deliberate bypass flag is set. This check is independent
    // of NODE_ENV — it applies in all environments.
    if (isSkipFixieCheck()) {
      if (!_skipWarned) {
        _skipWarned = true;
        console.warn('[WARN] avada.ts: UNIPESA_SKIP_FIXIE_CHECK is set — Unipesa/Avada call bypassing Fixie proxy (direct connection). IP whitelisting is NOT active.');
      }
      return undefined;
    }
    throw new Error('FIXIE_PROXY_REQUIRED: FIXIE_URL is not set and UNIPESA_SKIP_FIXIE_CHECK is not enabled. Unipesa/Avada calls require the Fixie proxy for IP whitelisting.');
  }
  if (!_proxyAgent) _proxyAgent = new ProxyAgent(env.FIXIE_URL);
  return _proxyAgent;
}

async function unipesaPost(publicId: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dispatcher = getProxyAgent();
  const res = await undiciFetch(`${BASE}/${publicId}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    ...(dispatcher ? { dispatcher } : {}),
  } as Parameters<typeof undiciFetch>[1]);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Unipesa HTTP ${res.status}: ${text}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unipesa non-JSON response: ${text}`);
  }
  // Unipesa returns HTTP 200 even when the provider call fails. The
  // result.code field is 0 on success and non-zero on failure (e.g.
  // 10301 = "REQUEST SENDING ERROR | get token error" when the
  // operator API is unreachable). Without this check, failed
  // provider calls are silently treated as "processing" and the
  // transaction gets stuck forever (no callback will ever arrive).
  //
  // IMPORTANT: this check only applies to payment INITIATION calls
  // (/payment_c2b, /payment_b2c). The /status endpoint also returns
  // a non-zero result.code when the TRANSACTION failed (e.g. 10301
  // for a failed Airtel withdrawal) — but the response still contains
  // the authoritative status (status=3) that the reconciliation job
  // needs. Throwing on /status would prevent status resolution.
  const isStatusEndpoint = path === '/status' || path === '/balance';
  if (!isStatusEndpoint) {
    const resultCode = json['result'];
    if (resultCode && typeof resultCode === 'object') {
      const code = (resultCode as Record<string, unknown>)['code'];
      const message = (resultCode as Record<string, unknown>)['message'];
      if (code !== undefined && code !== 0 && code !== '0') {
        throw new Error(`Unipesa provider error: code=${code} message=${message ?? '(no message)'}`);
      }
    }
  }
  return json;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatPhoneForOperator(phone: string, operator: string): string {
  return normalizePhoneForOperator(phone, operator.toLowerCase() as 'orange' | 'airtel' | 'afrimoney');
}

function findBalanceValue(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const directKeys = ['balance', 'balance_cdf', 'available_balance', 'available', 'amount', 'solde'];
  for (const key of directKeys) {
    const value = toNumber(obj[key]);
    if (value !== null) return value;
  }
  for (const value of Object.values(obj)) {
    const nested = findBalanceValue(value);
    if (nested !== null) return nested;
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initiateCollection(
  operator: string,
  phone: string,
  amount: number,
  reference: string,
  currency = 'CDF',
): Promise<{ avada_transaction_id: string }> {
  const { publicId, merchantId, secretKey, callbackUrl } = requireUnipesaEnv();
  const provider_id = PROVIDER_IDS[operator.toLowerCase()];
  if (!provider_id) throw new Error(`Unknown operator: ${operator}`);

  const payload: Record<string, unknown> = {
    merchant_id:  merchantId,
    customer_id:  formatPhoneForOperator(phone, operator),
    order_id:     reference,
    amount,
    currency,
    country:      'CD',
    callback_url: callbackUrl,
    provider_id,
  };
  payload['signature'] = calculateSignature(payload, secretKey);

  const data = await unipesaPost(publicId, '/payment_c2b', payload);
  console.log('[avada:initiateCollection] raw response:', JSON.stringify(data));
  const avadaId =
    data['transaction_id'] ||
    data['order_id'] ||
    data['payment_id'] ||
    data['trx_id'] ||
    data['id'] ||
    null;
  // If Unipesa returned OK (result.code=0) but no transaction_id was
  // created, the provider rejected the request (e.g. Airtel returning
  // "An unexpected error occurred" with provider_result.code=-8888).
  // Without a transaction_id, no callback will ever arrive — the
  // transaction would be stuck in "processing" forever.
  if (!avadaId) {
    const providerResult = data['provider_result'] as Record<string, unknown> | undefined;
    const providerMsg = providerResult?.['message'] ?? '(no provider message)';
    throw new Error(`Unipesa provider did not create a transaction: ${providerMsg}`);
  }
  return { avada_transaction_id: String(avadaId) };
}

export async function initiatePayout(
  operator: string,
  phone: string,
  amount: number,
  reference: string,
  currency = 'CDF',
): Promise<{ avada_transaction_id: string }> {
  const { publicId, merchantId, secretKey, callbackUrl } = requireUnipesaEnv();
  const provider_id = PROVIDER_IDS[operator.toLowerCase()];
  if (!provider_id) throw new Error(`Unknown operator: ${operator}`);

  const payload: Record<string, unknown> = {
    merchant_id:  merchantId,
    customer_id:  formatPhoneForOperator(phone, operator),
    order_id:     reference,
    amount,
    currency,
    country:      'CD',
    callback_url: callbackUrl,
    provider_id,
  };
  payload['signature'] = calculateSignature(payload, secretKey);

  const data = await unipesaPost(publicId, '/payment_b2c', payload);
  console.log('[avada:initiatePayout] raw response:', JSON.stringify(data));
  const avadaId =
    data['transaction_id'] ||
    data['order_id'] ||
    data['payment_id'] ||
    data['trx_id'] ||
    data['id'] ||
    null;
  console.log('[avada:initiatePayout] resolved avada_id:', avadaId);
  // Same guard as initiateCollection: no transaction_id means the
  // provider rejected the request and no callback will ever arrive.
  if (!avadaId) {
    const providerResult = data['provider_result'] as Record<string, unknown> | undefined;
    const providerMsg = providerResult?.['message'] ?? '(no provider message)';
    throw new Error(`Unipesa provider did not create a transaction: ${providerMsg}`);
  }
  return { avada_transaction_id: String(avadaId) };
}

export async function getTransactionStatus(avadaTransactionId: string): Promise<AvadaStatus> {
  const { publicId, merchantId, secretKey } = requireUnipesaEnv();
  const payload: Record<string, unknown> = {
    merchant_id: merchantId,
    order_id:    avadaTransactionId,
  };
  payload['signature'] = calculateSignature(payload, secretKey);
  const data = await unipesaPost(publicId, '/status', payload);
  // Unipesa returns numeric status (0=pending, 1=processing, 2=success,
  // 3=failed, -1=not found). Map to AvadaStatus text so the reconciliation
  // worker and callback route can compare against string values. Treat
  // -1 (PARENT OPERATION NOT FOUND) as 'failed' so stale transactions
  // that Unipesa no longer knows about can be resolved.
  const rawStatus = data['status'];
  if (typeof rawStatus === 'number') {
    if (rawStatus === -1) return 'failed';
    return CALLBACK_STATUS_MAP[rawStatus] ?? 'pending';
  }
  return (rawStatus as AvadaStatus) ?? 'pending';
}

export async function getBalance(): Promise<UnipesaBalance> {
  const { publicId, merchantId, secretKey } = requireUnipesaEnv();
  const payload: Record<string, unknown> = {
    merchant_id: merchantId,
    order_id: `BAL-${Date.now()}`,
  };
  payload['signature'] = calculateSignature(payload, secretKey);
  console.log('[avada:getBalance] calling Unipesa balance endpoint');
  const data = await unipesaPost(publicId, '/balance', payload);
  console.log('[avada:getBalance] raw response:', JSON.stringify(data));
  const balance = findBalanceValue(data);
  console.log('[avada:getBalance] parsed balance:', balance);
  if (balance === null) {
    throw new Error(`Unipesa balance response does not contain a recognized balance field: ${JSON.stringify(data)}`);
  }
  return { balance, currency: 'CDF' };
}

// Callback signature verification — HMAC-SHA512, same as congogaming
export function verifyCallbackSignature(body: Record<string, unknown>): boolean {
  if (!env.UNIPESA_SECRET_KEY) return false;
  const provided = String(body['signature'] ?? '');
  if (!provided) return false;
  const expected = calculateSignature(body, env.UNIPESA_SECRET_KEY);
  return provided.toLowerCase() === expected.toLowerCase();
}

export function normalizeCallback(payload: AvadaCallbackPayload): NormalizedCallback {
  return {
    avada_transaction_id: payload.transaction_id,
    reference:            payload.order_id,
    status:               CALLBACK_STATUS_MAP[payload.status] ?? 'pending',
    operator:             CALLBACK_PROVIDER_MAP[payload.provider_id] ?? String(payload.provider_id),
    amount:               payload.amount,
    phone:                payload.customer_id,
    raw:                  payload,
  };
}

// ── Sandbox (test mode) ───────────────────────────────────────────────────────

export function sandboxCollection(_amount: number): { avada_transaction_id: string } {
  return { avada_transaction_id: `sandbox_${crypto.randomUUID()}` };
}

export function sandboxPayout(_amount: number): { avada_transaction_id: string } {
  return { avada_transaction_id: `sandbox_${crypto.randomUUID()}` };
}
