import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyUsdtWithdrawal, verifyWcgltMint } from '../lib/bsc-withdrawal';

interface ReconciliationLogger {
  info: (data: unknown, message?: string) => void;
  warn: (data: unknown, message?: string) => void;
  error: (data: unknown, message?: string) => void;
}

export async function reconcilePendingOnchainOperations(
  supabase: SupabaseClient,
  log: ReconciliationLogger,
): Promise<void> {
  const { data: withdrawals, error: withdrawalError } = await supabase
    .from('withdrawal_requests')
    .select('id, destination_address, amount, fee, tx_hash')
    .eq('status', 'pending_onchain_check')
    .not('tx_hash', 'is', null)
    .limit(50);

  if (withdrawalError) {
    log.error({ err: withdrawalError }, '[onchain-reconcile] withdrawal query failed');
  } else {
    for (const row of withdrawals ?? []) {
      try {
        const netAmount = Number(row.amount) - Number(row.fee ?? 0);
        const status = await verifyUsdtWithdrawal(row.tx_hash, row.destination_address, netAmount);
        if (status !== 'confirmed' && status !== 'failed') continue;
        const { error } = await supabase.rpc('resolve_usdt_withdrawal_onchain', {
          p_withdrawal_id: row.id,
          p_outcome: status,
          p_tx_hash: row.tx_hash,
          p_reason: status === 'failed' ? 'ONCHAIN_RECEIPT_FAILED' : null,
        });
        if (error) throw error;
        log.info({ withdrawalId: row.id, txHash: row.tx_hash, status }, '[onchain-reconcile] USDT withdrawal resolved');
      } catch (err) {
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
      const status = await verifyWcgltMint(row.tx_hash, row.recipient, Number(row.amount_onchain));
      if (status !== 'confirmed' && status !== 'failed') continue;
      const { error } = await supabase.rpc('resolve_wcglt_onchain_operation', {
        p_operation_id: row.id,
        p_outcome: status,
        p_tx_hash: row.tx_hash,
        p_reason: status === 'failed' ? 'ONCHAIN_RECEIPT_FAILED' : null,
      });
      if (error) throw error;
      log.info({ operationId: row.id, txHash: row.tx_hash, status }, '[onchain-reconcile] wCGLT operation resolved');
    } catch (err) {
      log.error({ err, operationId: row.id }, '[onchain-reconcile] wCGLT verification failed');
    }
  }
}

export function startOnchainReconciler(
  supabase: SupabaseClient,
  log: ReconciliationLogger,
  intervalMs = 60_000,
): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePendingOnchainOperations(supabase, log);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(() => void run(), intervalMs);
}
