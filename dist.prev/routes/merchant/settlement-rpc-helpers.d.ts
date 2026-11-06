import type { SupabaseClient } from '@supabase/supabase-js';
/**
 * Mark a settlement request as processing after initiatePayout() succeeds.
 * Stores the provider_ref (avada_transaction_id) so the callback can link
 * back, but keeps status='processing' until the operator callback confirms
 * success or failure. Replaces the premature markSettlementSuccess call
 * that marked settlements as 'success' before the callback arrived.
 */
export declare function markSettlementProcessing(supabase: SupabaseClient, requestId: string, providerRef: string): Promise<void>;
/**
 * Mark a settlement request as successful after a B2C payout completes.
 */
export declare function markSettlementSuccess(supabase: SupabaseClient, requestId: string, providerRef: string): Promise<void>;
/**
 * Mark a settlement request as failed and re-credit the merchant's ledger.
 */
export declare function markSettlementFailed(supabase: SupabaseClient, requestId: string, reason: string): Promise<void>;
/**
 * Reject a settlement request (admin action) and re-credit the ledger.
 */
export declare function rejectSettlement(supabase: SupabaseClient, requestId: string, reason: string): Promise<{
    rejected: boolean;
    recredited: number;
    balance_after: number;
}>;
