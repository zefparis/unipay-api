import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';
export declare function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse>;
export declare function checkStatus(providerRef: string): Promise<ProviderStatus>;
