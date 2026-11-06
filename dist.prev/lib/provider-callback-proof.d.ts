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
export type ProviderProofResult = {
    valid: true;
} | {
    valid: false;
    reason: 'REFERENCE_MISMATCH' | 'AMOUNT_MISMATCH' | 'PHONE_MISMATCH' | 'OPERATOR_MISMATCH' | 'CURRENCY_MISMATCH';
};
export declare function validateProviderCallbackProof(callback: ProviderCallbackProof, transaction: StoredProviderTransaction): ProviderProofResult;
