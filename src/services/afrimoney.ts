import { env } from '../config/env';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * Afrimoney (Africell RDC) service stub.
 * USSD: *555#
 * TODO: Replace with real Afrimoney API calls.
 * Credentials: env.AFRIMONEY_API_URL, env.AFRIMONEY_API_KEY
 */

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  void env.AFRIMONEY_API_URL;

  const providerRef = `AFM-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;

  return {
    provider_ref: providerRef,
    status: 'processing',
    raw: { stub: true, channel: 'afrimoney', payload },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'processing',
    message: 'Stub: Afrimoney status check not yet implemented',
  };
}
