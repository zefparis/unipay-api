/**
 * Diagnostic: quantify exposure of the settlement-propagation regression.
 * All merchant_settlement_requests stuck in 'processing', joined to their
 * linked transactions row and any compensating ledger credit.
 *
 * Usage: npx tsx scripts/diag-stuck-settlement.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── All settlements still 'processing' ──
  const { data: settlements, error } = await supabase
    .from('merchant_settlement_requests')
    .select('id, merchant_id, amount, currency, phone, status, provider_ref, created_at, updated_at, reconcile_attempted_at, ledger_entry_id')
    .eq('status', 'processing')
    .order('created_at', { ascending: true });
  if (error) { console.error('settlement query error:', error); process.exit(1); }
  console.log(`=== Settlements in 'processing': ${settlements?.length ?? 0} ===\n`);

  const merchantIds = [...new Set((settlements ?? []).map(s => s.merchant_id))];
  const { data: merchants } = await supabase
    .from('merchants').select('id, name').in('id', merchantIds.length ? merchantIds : ['00000000-0000-0000-0000-000000000000']);
  const mName = new Map((merchants ?? []).map(m => [m.id, m.name]));

  for (const s of settlements ?? []) {
    const { data: tx } = await supabase
      .from('transactions')
      .select('id, status, operator, phone, amount, currency, reference, avada_transaction_id, metadata, created_at, updated_at')
      .eq('settlement_request_id', s.id)
      .maybeSingle();

    // Candidate re-credit: 'credit' ledger entry, same merchant+currency+amount,
    // created AFTER the settlement debit. (Heuristic — manual fixes also match.)
    const { data: credits } = await supabase
      .from('merchant_ledger_entries')
      .select('id, type, amount, currency, balance_after, created_at, transaction_id')
      .eq('merchant_id', s.merchant_id)
      .eq('currency', s.currency)
      .eq('type', 'credit')
      .eq('amount', s.amount)
      .gt('created_at', s.created_at);

    console.log(JSON.stringify({
      settlement_id: s.id,
      merchant: mName.get(s.merchant_id) ?? s.merchant_id,
      amount: s.amount,
      currency: s.currency,
      created_at: s.created_at,
      provider_ref: s.provider_ref,
      linked_tx: tx ? {
        id: tx.id,
        status: tx.status,
        operator: tx.operator,
        phone: tx.phone,
        reference: tx.reference,
        avada_transaction_id: tx.avada_transaction_id,
        provider_code: tx.metadata?.provider_payload?.provider_result?.code ?? tx.metadata?.provider_result?.code ?? null,
        provider_msg: tx.metadata?.provider_payload?.provider_result?.message ?? tx.metadata?.provider_result?.message ?? null,
      } : null,
      recredit_candidates: (credits ?? []).map(c => ({ id: c.id, amount: c.amount, created_at: c.created_at })),
    }, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
