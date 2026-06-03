import { env } from '../config/env';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

/**
 * USDT (Tether) service stub.
 * TODO: Replace with real on-chain / custodial USDT payment logic.
 * Config: env.USDT_WALLET_ADDRESS
 */

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  void env.USDT_WALLET_ADDRESS;

  const providerRef = `USDT-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;

  return {
    provider_ref: providerRef,
    status: 'processing',
    raw: {
      stub: true,
      channel: 'usdt',
      wallet: env.USDT_WALLET_ADDRESS ?? 'NOT_SET',
      payload,
    },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  return {
    provider_ref: providerRef,
    status: 'processing',
    message: 'Stub: USDT on-chain confirmation not yet implemented',
  };
}
