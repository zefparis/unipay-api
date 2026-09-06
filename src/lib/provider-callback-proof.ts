export interface ProviderCallbackProof {
  reference: string;
  amount: number;
  phone: string;
  operator: string;
  currency?: string;
}

export interface StoredProviderTransaction {
  reference: string | null;
  amount: number;
  phone: string;
  operator: string;
  currency: string;
}

export type ProviderProofResult =
  | { valid: true }
  | { valid: false; reason: 'REFERENCE_MISMATCH' | 'AMOUNT_MISMATCH' | 'PHONE_MISMATCH' | 'OPERATOR_MISMATCH' | 'CURRENCY_MISMATCH' };

function normalizePhone(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function validateProviderCallbackProof(
  callback: ProviderCallbackProof,
  transaction: StoredProviderTransaction,
): ProviderProofResult {
  if (!transaction.reference || callback.reference !== transaction.reference) {
    return { valid: false, reason: 'REFERENCE_MISMATCH' };
  }

  const callbackAmount = Number(callback.amount);
  const transactionAmount = Number(transaction.amount);
  if (!Number.isFinite(callbackAmount) || callbackAmount <= 0 || callbackAmount !== transactionAmount) {
    return { valid: false, reason: 'AMOUNT_MISMATCH' };
  }

  if (normalizePhone(callback.phone) !== normalizePhone(transaction.phone)) {
    return { valid: false, reason: 'PHONE_MISMATCH' };
  }

  if (callback.operator.toLowerCase() !== transaction.operator.toLowerCase()) {
    return { valid: false, reason: 'OPERATOR_MISMATCH' };
  }

  if (callback.currency && callback.currency.toUpperCase() !== transaction.currency.toUpperCase()) {
    return { valid: false, reason: 'CURRENCY_MISMATCH' };
  }

  return { valid: true };
}
