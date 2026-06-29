import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';
/**
 * Vodacash / M-Pesa (Vodacom DRC) — direct integration, NOT via Avada.
 * CGL is currently in due diligence with Vodacom DRC.
 * This service is intentionally unreachable: initiate.ts guards against
 * vodacash requests and returns 503 before calling this service.
 */
export declare function initiatePayment(_payload: PaymentPayload): Promise<ProviderResponse>;
export declare function checkStatus(providerRef: string): Promise<ProviderStatus>;
