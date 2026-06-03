import { env } from '../config/env';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * Orange Money DRC service stub.
 * TODO: Replace with real Orange Money API calls (OAuth2 flow).
 * Credentials: env.ORANGE_API_URL, env.ORANGE_CLIENT_ID, env.ORANGE_CLIENT_SECRET
 */

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  void env.ORANGE_API_URL;

  const providerRef = `OMD-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;

  return {
    provider_ref: providerRef,
    status: 'processing',
    raw: { stub: true, channel: 'orange', payload },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'processing',
    message: 'Stub: Orange Money status check not yet implemented',
  };
}
