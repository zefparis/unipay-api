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
  // DRC country code is 243. Unipesa callbacks send the local 9-digit
  // number (e.g. "970967029") while the DB stores E.164 ("+243970967029").
  // Normalize both to the 9-digit local number by stripping a leading
  // "243" when the remaining digits form a valid DRC local number (9 digits
  // starting with 8 or 9).
  if (digits.length === 12 && digits.startsWith('243')) {
    const local = digits.slice(3);
    if (local.length === 9 && /^[89]/.test(local)) {
      digits = local;
    }
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
