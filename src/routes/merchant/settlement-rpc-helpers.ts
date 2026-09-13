import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Mark a settlement request as processing after initiatePayout() succeeds.
 * Stores the provider_ref (avada_transaction_id) so the callback can link
 * back, but keeps status='processing' until the operator callback confirms
 * success or failure. Replaces the premature markSettlementSuccess call
 * that marked settlements as 'success' before the callback arrived.
 */
export async function markSettlementProcessing(
  supabase: SupabaseClient,
  requestId: string,
  providerRef: string,
): Promise<void> {
  const { error } = await supabase.rpc('mark_settlement_processing', {
    p_request_id: requestId,
    p_provider_ref: providerRef,
  });
  if (error) throw error;
}

/**
 * Mark a settlement request as successful after a B2C payout completes.
 */
export async function markSettlementSuccess(
  supabase: SupabaseClient,
  requestId: string,
  providerRef: string,
): Promise<void> {
  const { error } = await supabase.rpc('mark_settlement_success', {
    p_request_id: requestId,
    p_provider_ref: providerRef,
  });
  if (error) throw error;
}

/**
 * Mark a settlement request as failed and re-credit the merchant's ledger.
 */
export async function markSettlementFailed(
  supabase: SupabaseClient,
  requestId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('mark_settlement_failed', {
    p_request_id: requestId,
    p_reason: reason,
  });
  if (error) throw error;
}

/**
 * Reject a settlement request (admin action) and re-credit the ledger.
 */
export async function rejectSettlement(
  supabase: SupabaseClient,
  requestId: string,
  reason: string,
): Promise<{ rejected: boolean; recredited: number; balance_after: number }> {
  const { data, error } = await supabase.rpc('reject_settlement', {
    p_request_id: requestId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as { rejected: boolean; recredited: number; balance_after: number };
}
