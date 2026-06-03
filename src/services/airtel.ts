import { env } from '../config/env';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * Airtel Money DRC service stub.
 * TODO: Replace with real Airtel Money Africa API calls.
 * Credentials: env.AIRTEL_API_URL, env.AIRTEL_CLIENT_ID, env.AIRTEL_CLIENT_SECRET
 */

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  void env.AIRTEL_API_URL;

  const providerRef = `ATL-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;

  return {
    provider_ref: providerRef,
    status: 'processing',
    raw: { stub: true, channel: 'airtel', payload },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'processing',
    message: 'Stub: Airtel Money status check not yet implemented',
  };
}
