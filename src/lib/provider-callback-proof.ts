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
  // Strip everything except digits
  let digits = value.replace(/\D/g, '');
  // DRC country code is 243. Strip it if present.
  // Unipesa callbacks send local numbers (Airtel: 9 digits no prefix,
  // Orange/Africell: 10 digits with leading 0). DB stores mixed formats
  // (E.164 with +243, or local). Normalize everything to the 9-digit
  // local number by stripping BOTH the country code AND any leading 0.
  if (digits.startsWith('243')) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits;
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
