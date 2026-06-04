import crypto from 'node:crypto';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { env } from '../config/env';

export type AvadaOperator = 'Orange' | 'Airtel' | 'Afrimoney';
export type AvadaStatus = 'pending' | 'processing' | 'success' | 'failed' | 'cancelled';

interface UnipesaEnvelope<T> {
  status: 'success' | 'error';
  data: T;
  message?: string;
}

interface UnipesaTransactionData {
  transaction_id: string;
  status: AvadaStatus;
  reference?: string;
  operator?: string;
  amount?: number;
  msisdn?: string;
}

export interface AvadaCallbackPayload {
  transaction_id: string;
  reference: string;
  status: AvadaStatus;
  operator: string;
  amount: number;
  msisdn: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireUnipesaEnv(): { url: string; publicId: string; merchantId: string } {
  if (!env.UNIPESA_API_URL || !env.UNIPESA_PUBLIC_ID || !env.UNIPESA_MERCHANT_ID) {
    throw new Error(
      'Unipesa integration not configured: UNIPESA_API_URL, UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID required',
    );
  }
  return {
    url: env.UNIPESA_API_URL,
    publicId: env.UNIPESA_PUBLIC_ID,
    merchantId: env.UNIPESA_MERCHANT_ID,
  };
}

// Re-use a single ProxyAgent instance for all requests (keepAlive)
let _proxyAgent: ProxyAgent | undefined;
function getProxyAgent(): ProxyAgent | undefined {
  if (!env.FIXIE_URL) return undefined;
  if (!_proxyAgent) _proxyAgent = new ProxyAgent(env.FIXIE_URL);
  return _proxyAgent;
}

async function unipesaRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<T> {
  const { url, publicId, merchantId } = requireUnipesaEnv();
  const dispatcher = getProxyAgent();

  // URL pattern: {base}/{publicId}{path}  e.g. https://api.unipesa.tech/{id}/payment_c2b
  const res = await undiciFetch(`${url}/${publicId}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': publicId,
      'X-Merchant-Id': merchantId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
    ...(dispatcher ? { dispatcher } : {}),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Unipesa HTTP ${res.status}: ${text}`);
  }

  let json: UnipesaEnvelope<T>;
  try {
    json = JSON.parse(text) as UnipesaEnvelope<T>;
  } catch {
    throw new Error(`Unipesa non-JSON response: ${text}`);
  }

  if (json.status !== 'success') {
    throw new Error(`Unipesa error: ${json.message ?? JSON.stringify(json)}`);
  }

  return json.data;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initiateCollection(
  operator: AvadaOperator,
  phone: string,
  amount: number,
  reference: string,
  currency = 'CDF',
): Promise<{ avada_transaction_id: string }> {
  const data = await unipesaRequest<UnipesaTransactionData>('POST', '/payment_c2b', {
    operator,
    msisdn: phone,
    amount,
    currency,
    reference,
    callback_url: env.UNIPESA_CALLBACK_URL,
  });
  return { avada_transaction_id: data.transaction_id };
}

export async function initiatePayout(
  operator: AvadaOperator,
  phone: string,
  amount: number,
  reference: string,
  currency = 'CDF',
): Promise<{ avada_transaction_id: string }> {
  const data = await unipesaRequest<UnipesaTransactionData>('POST', '/payment_b2c', {
    operator,
    msisdn: phone,
    amount,
    currency,
    reference,
    callback_url: env.UNIPESA_CALLBACK_URL,
  });
  return { avada_transaction_id: data.transaction_id };
}

export async function getTransactionStatus(avadaTransactionId: string): Promise<AvadaStatus> {
  const data = await unipesaRequest<UnipesaTransactionData>(
    'GET',
    `/status?transaction_id=${encodeURIComponent(avadaTransactionId)}`,
  );
  return data.status;
}

export interface UnipesaBalance {
  balance: number;
  currency: string;
}

export async function getBalance(): Promise<UnipesaBalance> {
  return unipesaRequest<UnipesaBalance>('GET', '/balance');
}

export function verifyCallbackSignature(rawBody: string, signature: string): boolean {
  if (!env.UNIPESA_SECRET_KEY) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', env.UNIPESA_SECRET_KEY)
    .update(rawBody)
    .digest('hex')}`;
  try {
    return (
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    );
  } catch {
    return false;
  }
}

export function normalizeCallback(payload: AvadaCallbackPayload): NormalizedCallback {
  return {
    avada_transaction_id: payload.transaction_id,
    reference: payload.reference,
    status: payload.status,
    operator: payload.operator.toLowerCase(),
    amount: payload.amount,
    phone: payload.msisdn,
    raw: payload,
  };
}
