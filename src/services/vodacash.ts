import { env } from '../config/env';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * Vodacash (Vodacom DRC) service stub.
 * TODO: Replace with real Vodacash / M-Pesa API calls.
 * Credentials: env.VODACASH_API_URL, env.VODACASH_API_KEY
 */

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  // Real implementation will POST to env.VODACASH_API_URL with HMAC-signed body
  void env.VODACASH_API_URL; // referenced to avoid unused-var lint

  const providerRef = `VDC-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;

  return {
    provider_ref: providerRef,
    status: 'processing',
    raw: { stub: true, channel: 'vodacash', payload },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'processing',
    message: 'Stub: Vodacash status check not yet implemented',
  };
}
