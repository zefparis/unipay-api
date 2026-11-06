"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markSettlementProcessing = markSettlementProcessing;
exports.markSettlementSuccess = markSettlementSuccess;
exports.markSettlementFailed = markSettlementFailed;
exports.rejectSettlement = rejectSettlement;
/**
 * Mark a settlement request as processing after initiatePayout() succeeds.
 * Stores the provider_ref (avada_transaction_id) so the callback can link
 * back, but keeps status='processing' until the operator callback confirms
 * success or failure. Replaces the premature markSettlementSuccess call
 * that marked settlements as 'success' before the callback arrived.
 */
async function markSettlementProcessing(supabase, requestId, providerRef) {
    const { error } = await supabase.rpc('mark_settlement_processing', {
        p_request_id: requestId,
        p_provider_ref: providerRef,
    });
    if (error)
        throw error;
}
/**
 * Mark a settlement request as successful after a B2C payout completes.
 */
async function markSettlementSuccess(supabase, requestId, providerRef) {
    const { error } = await supabase.rpc('mark_settlement_success', {
        p_request_id: requestId,
        p_provider_ref: providerRef,
    });
    if (error)
        throw error;
}
/**
 * Mark a settlement request as failed and re-credit the merchant's ledger.
 */
async function markSettlementFailed(supabase, requestId, reason) {
    const { error } = await supabase.rpc('mark_settlement_failed', {
        p_request_id: requestId,
        p_reason: reason,
    });
    if (error)
        throw error;
}
/**
 * Reject a settlement request (admin action) and re-credit the ledger.
 */
async function rejectSettlement(supabase, requestId, reason) {
    const { data, error } = await supabase.rpc('reject_settlement', {
        p_request_id: requestId,
        p_reason: reason,
    });
    if (error)
        throw error;
    return data;
}
//# sourceMappingURL=settlement-rpc-helpers.js.map