/** Maps mobile-money operator slug to the Unipesa numeric provider_id (CDF flows). */
export declare const UNIPESA_PROVIDER_IDS: Record<string, number>;
/**
 * Maps mobile-money operator slug to the Unipesa numeric provider_id for USD flows.
 * USD providers have different IDs from their CDF equivalents.
 *   Orange USD  → 10
 *   Airtel USD  → 17
 *   Africell USD → 19
 */
export declare const UNIPESA_USD_PROVIDER_IDS: Record<string, number>;
export type UnipesaResponse = {
    status?: number;
    transaction_id?: string;
    message?: string;
    [k: string]: any;
};
/**
 * Build the Unipesa request signature (HMAC-SHA-512 over sorted key=value pairs).
 * The `signature` key itself is excluded from the digest.
 */
export declare function calculateSignature(data: Record<string, any>, secretKey: string): string;
export declare function newOrderId(): string;
/**
 * C2B — collect USD from a subscriber's mobile money into UniPay.
 * `customer_id` is the subscriber's full phone number (e.g. +243XXXXXXXXX).
 */
export declare function depositUSD(opts: {
    order_id: string;
    customer_id: string;
    amount: number;
    provider_id: number;
}, signal?: AbortSignal): Promise<UnipesaResponse>;
/**
 * B2C — pay out USD from UniPay to a subscriber's mobile money.
 */
export declare function withdrawUSD(opts: {
    order_id: string;
    customer_id: string;
    amount: number;
    provider_id: number;
}, signal?: AbortSignal): Promise<UnipesaResponse>;
/**
 * Verify that a callback body has a valid Unipesa signature.
 * Always returns false when UNIPESA_SECRET_KEY is not set.
 */
export declare function verifyCallbackSignature(body: Record<string, any>): boolean;
