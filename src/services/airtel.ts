import * as avada from './avada';
import type { PaymentPayload, ProviderResponse, ProviderStatus } from '../types/payment';

const OPERATOR = 'Airtel' as const;

export async function initiatePayment(payload: PaymentPayload): Promise<ProviderResponse> {
  const { avada_transaction_id } =
    payload.direction === 'collect'
      ? await avada.initiateCollection(OPERATOR, payload.phone, payload.amount, payload.reference, payload.currency)
      : await avada.initiatePayout(OPERATOR, payload.phone, payload.amount, payload.reference, payload.currency);

  return {
    provider_ref: avada_transaction_id,
    status: 'processing',
    raw: { operator: OPERATOR, avada_transaction_id },
  };
}

export async function checkStatus(providerRef: string): Promise<ProviderStatus> {
  const avadaStatus = await avada.getTransactionStatus(providerRef);
  const status =
    avadaStatus === 'success' ? 'success'
    : avadaStatus === 'failed' || avadaStatus === 'cancelled' ? 'failed'
    : 'processing';
  return { provider_ref: providerRef, status };
}
