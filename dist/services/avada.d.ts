export type AvadaOperator = 'Orange' | 'Airtel' | 'Afrimoney';
export type AvadaStatus = 'pending' | 'processing' | 'success' | 'failed' | 'cancelled';
export interface AvadaCallbackPayload {
    order_id: string;
    transaction_id: string;
    status: number;
    customer_id: string;
    provider_id: number;
    amount: number;
    currency?: string;
    merchant_id?: string;
    signature?: string;
    [key: string]: unknown;
}
export interface NormalizedCallback {
    avada_transaction_id: string;
    reference: string;
    status: AvadaStatus;
    operator: string;
    amount: number;
    phone: string;
    raw: AvadaCallbackPayload;
}
export interface UnipesaBalance {
    balance: number;
    currency: string;
}
export declare function initiateCollection(operator: string, phone: string, amount: number, reference: string, currency?: string): Promise<{
    avada_transaction_id: string;
}>;
export declare function initiatePayout(operator: string, phone: string, amount: number, reference: string, currency?: string): Promise<{
    avada_transaction_id: string;
}>;
export declare function getTransactionStatus(avadaTransactionId: string): Promise<AvadaStatus>;
export declare function getBalance(): Promise<UnipesaBalance>;
export declare function verifyCallbackSignature(body: Record<string, unknown>): boolean;
export declare function normalizeCallback(payload: AvadaCallbackPayload): NormalizedCallback;
export declare function sandboxCollection(_amount: number): {
    avada_transaction_id: string;
};
export declare function sandboxPayout(_amount: number): {
    avada_transaction_id: string;
};
