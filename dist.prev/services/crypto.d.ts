import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';
/**
 * USDT (Tether) service stub.
 * TODO: Replace with real on-chain / custodial USDT payment logic.
 * Config: env.USDT_WALLET_ADDRESS
 */
export declare function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse>;
export declare function checkStatus(providerRef: string): Promise<ProviderStatus>;
