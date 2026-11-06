"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcilePendingOnchainOperations = reconcilePendingOnchainOperations;
exports.startOnchainReconciler = startOnchainReconciler;
const bsc_withdrawal_1 = require("../lib/bsc-withdrawal");
async function reconcilePendingOnchainOperations(supabase, log) {
    const { data: withdrawals, error: withdrawalError } = await supabase
        .from('withdrawal_requests')
        .select('id, destination_address, amount, fee, tx_hash')
        .eq('status', 'pending_onchain_check')
        .not('tx_hash', 'is', null)
        .limit(50);
    if (withdrawalError) {
        log.error({ err: withdrawalError }, '[onchain-reconcile] withdrawal query failed');
    }
    else {
        for (const row of withdrawals ?? []) {
            try {
                const netAmount = Number(row.amount) - Number(row.fee ?? 0);
                const status = await (0, bsc_withdrawal_1.verifyUsdtWithdrawal)(row.tx_hash, row.destination_address, netAmount);
                if (status !== 'confirmed' && status !== 'failed')
                    continue;
                const { error } = await supabase.rpc('resolve_usdt_withdrawal_onchain', {
                    p_withdrawal_id: row.id,
                    p_outcome: status,
                    p_tx_hash: row.tx_hash,
                    p_reason: status === 'failed' ? 'ONCHAIN_RECEIPT_FAILED' : null,
                });
                if (error)
                    throw error;
                log.info({ withdrawalId: row.id, txHash: row.tx_hash, status }, '[onchain-reconcile] USDT withdrawal resolved');
            }
            catch (err) {
                log.error({ err, withdrawalId: row.id }, '[onchain-reconcile] USDT verification failed');
            }
        }
    }
    const { data: operations, error: operationError } = await supabase
        .from('onchain_operations')
        .select('id, recipient, amount_onchain, tx_hash')
        .eq('status', 'pending_onchain_check')
        .not('tx_hash', 'is', null)
        .limit(50);
    if (operationError) {
        log.error({ err: operationError }, '[onchain-reconcile] wCGLT query failed');
        return;
    }
    for (const row of operations ?? []) {
        try {
            const status = await (0, bsc_withdrawal_1.verifyWcgltMint)(row.tx_hash, row.recipient, Number(row.amount_onchain));
            if (status !== 'confirmed' && status !== 'failed')
                continue;
            const { error } = await supabase.rpc('resolve_wcglt_onchain_operation', {
                p_operation_id: row.id,
                p_outcome: status,
                p_tx_hash: row.tx_hash,
                p_reason: status === 'failed' ? 'ONCHAIN_RECEIPT_FAILED' : null,
            });
            if (error)
                throw error;
            log.info({ operationId: row.id, txHash: row.tx_hash, status }, '[onchain-reconcile] wCGLT operation resolved');
        }
        catch (err) {
            log.error({ err, operationId: row.id }, '[onchain-reconcile] wCGLT verification failed');
        }
    }
}
function startOnchainReconciler(supabase, log, intervalMs = 60_000) {
    let running = false;
    const run = async () => {
        if (running)
            return;
        running = true;
        try {
            await reconcilePendingOnchainOperations(supabase, log);
        }
        finally {
            running = false;
        }
    };
    void run();
    setInterval(() => void run(), intervalMs);
}
//# sourceMappingURL=onchain-reconciliation.js.map