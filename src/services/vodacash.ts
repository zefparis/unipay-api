import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * Vodacash / M-Pesa (Vodacom DRC) — direct integration, NOT via Avada.
 * CGL is currently in due diligence with Vodacom DRC.
 * This service is intentionally unreachable: initiate.ts guards against
 * vodacash requests and returns 503 before calling this service.
 */

export async function initiatePayment(_payload: PaymentPayload): Promise<ProviderResponse> {
  throw new Error('Vodacash integration not yet available — CGL in due diligence with Vodacom DRC');
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'pending',
    message: 'Vodacash integration not yet available',
  };
}
