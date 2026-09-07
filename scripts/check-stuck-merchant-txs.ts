/**
 * Diagnostic script: check for stuck merchant transactions + manual Unipesa status.
 *
 * Usage:
 *   npx tsx scripts/check-stuck-merchant-txs.ts
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (loaded via src/config/env).
 * Optional: UNIPESA_PUBLIC_ID, UNIPESA_MERCHANT_ID, UNIPESA_SECRET_KEY for
 *           manual Unipesa /status lookup.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';
import { getTransactionStatus } from '../src/services/avada';

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── 1. Find stuck merchant transactions (processing > 30 min) ──
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: stuck, error: stuckErr } = await supabase
    .from('transactions')
    .select('id, merchant_id, operator, direction, amount, currency, phone, reference, avada_transaction_id, status, created_at, updated_at')
    .not('merchant_id', 'is', null)
    .eq('status', 'processing')
    .lt('created_at', thirtyMinAgo)
    .order('created_at', { ascending: false });

  if (stuckErr) {
    console.error('Query failed:', stuckErr);
    process.exit(1);
  }

  console.log('=== Stuck merchant transactions (processing > 30 min) ===');
  console.log(`Count: ${stuck?.length ?? 0}`);
  if (stuck && stuck.length > 0) {
    console.table(stuck.map(t => ({
      id: t.id.slice(0, 8),
      merchant_id: (t.merchant_id ?? '').slice(0, 20),
      operator: t.operator,
      direction: t.direction,
      amount: t.amount,
      currency: t.currency,
      reference: t.reference,
      avada_tx_id: (t.avada_transaction_id ?? '').slice(0, 20),
      created_at: t.created_at,
    })));
  }

  // ── 2. Manual Unipesa status check for a specific transaction ──
  // If a transaction ID is passed as argument, check its status at Unipesa
  const targetTxId = process.argv[2];
  if (targetTxId) {
    console.log(`\n=== Manual Unipesa status check for ${targetTxId} ===`);

    // Fetch the transaction from DB to get its avada_transaction_id
    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .select('id, avada_transaction_id, reference, status, amount, currency, merchant_id')
      .eq('id', targetTxId)
      .maybeSingle();

    if (txErr || !tx) {
      console.error('Transaction not found:', txErr?.message ?? 'no row');
      process.exit(1);
    }

    console.log('DB state:', {
      id: tx.id,
      status: tx.status,
      avada_transaction_id: tx.avada_transaction_id,
      reference: tx.reference,
      amount: tx.amount,
      currency: tx.currency,
    });

    // Try to get the real status from Unipesa
    const avadaId = tx.avada_transaction_id ?? tx.reference;
    if (!avadaId) {
      console.error('No avada_transaction_id or reference to query Unipesa');
      process.exit(1);
    }

    try {
      console.log(`Querying Unipesa /status for order_id: ${avadaId} ...`);
      const remoteStatus = await getTransactionStatus(avadaId);
      console.log('Unipesa remote status:', remoteStatus);

      if (remoteStatus === 'success') {
        console.log('⚠️  Unipesa says SUCCESS but DB says', tx.status);
        console.log('   The callback was likely lost/misrouted.');
        console.log('   To fix: manually update the transaction status via:');
        console.log(`   UPDATE transactions SET status='success', updated_at=now() WHERE id='${tx.id}';`);
        console.log('   Then run process_wallet_provider_callback RPC to credit the merchant ledger.');
      } else if (remoteStatus === 'failed') {
        console.log('Unipesa says FAILED — the transaction should be marked as failed.');
        console.log(`   To fix: UPDATE transactions SET status='failed', updated_at=now() WHERE id='${tx.id}';`);
      } else {
        console.log(`Unipesa says ${remoteStatus} — transaction is still pending at the provider.`);
      }
    } catch (err: any) {
      console.error('Unipesa status check failed:', err?.message ?? err);
      console.error('The provider may be unreachable or the transaction ID is not recognized.');
    }
  } else if (stuck && stuck.length > 0) {
    console.log('\nTo check a specific transaction at Unipesa, run:');
    console.log(`  npx tsx scripts/check-stuck-merchant-txs.ts <transaction_id>`);
    console.log('\nFor example:');
    console.log(`  npx tsx scripts/check-stuck-merchant-txs.ts ${stuck[0].id}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
