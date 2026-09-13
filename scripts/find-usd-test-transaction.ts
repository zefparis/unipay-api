/**
 * READ-ONLY diagnostic: find the 5000 USD test transaction visible in
 * the "Revenus Marchands" admin page (Live uniquement, 30 days, USD).
 *
 * The transaction was made by Benji as a test BEFORE sandbox/live
 * differentiation was implemented, so it has no metadata.sandbox=true
 * and its merchant was in 'live' mode at the time. It shows up as a
 * real merchant transaction in revenue stats.
 *
 * This script:
 *   1. Finds the transaction(s) matching: currency=USD, amount≈5000,
 *      direction=collect, status=success, within the last 30 days.
 *   2. Shows the associated merchant (name, mode, email).
 *   3. Checks if a merchant_ledger_entries credit was created for it.
 *   4. Checks if any settlement was paid against that ledger credit.
 *   5. Proposes the safest fix option.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx tsx scripts/find-usd-test-transaction.ts
 *
 * This script is READ-ONLY — it does not modify any data.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

async function main() {
  console.log('=== Find USD 5000 test transaction ===\n');

  // ── 1. Find candidate transactions ──
  // Look for USD collect transactions with amount around 5000, success status,
  // within the last 30 days. We cast a wide net first (amount >= 4000 AND <= 6000)
  // to account for fee/net_amount variations.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  console.log(`Searching for USD collect transactions (amount 4000-6000) since ${thirtyDaysAgo}...`);

  const { data: candidates, error: txErr } = await supabase
    .from('transactions')
    .select('id, merchant_id, operator, phone, amount, fee, net_amount, currency, status, direction, reference, avada_transaction_id, metadata, created_at, updated_at')
    .eq('currency', 'USD')
    .eq('direction', 'collect')
    .eq('status', 'success')
    .gte('amount', 4000)
    .lte('amount', 6000)
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false });

  if (txErr) {
    console.error('Error querying transactions:', txErr.message);
    return;
  }

  const txs = candidates ?? [];
  console.log(`Found ${txs.length} candidate transaction(s)\n`);

  if (txs.length === 0) {
    // Widen the search — maybe the amount is stored differently, or it's older
    console.log('No candidates in 4000-6000 range. Widening to all USD collect success in 30 days...');
    const { data: allUsd } = await supabase
      .from('transactions')
      .select('id, merchant_id, amount, fee, net_amount, currency, status, direction, metadata, created_at')
      .eq('currency', 'USD')
      .eq('direction', 'collect')
      .eq('status', 'success')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false });
    console.log(`Found ${(allUsd ?? []).length} USD collect success transactions in 30 days:`);
    for (const t of (allUsd ?? [])) {
      console.log(`  ${t.id}  amount=${fmt(Number(t.amount))}  fee=${fmt(Number(t.fee))}  net=${fmt(Number(t.net_amount))}  ${t.created_at}  sandbox=${(t.metadata as Record<string, unknown>)?.sandbox ?? false}`);
    }
    return;
  }

  // ── 2. For each candidate, show full details + merchant info ──
  for (const tx of txs) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Transaction: ${tx.id}`);
    console.log(`  merchant_id:       ${tx.merchant_id}`);
    console.log(`  operator:          ${tx.operator}`);
    console.log(`  phone:             ${tx.phone}`);
    console.log(`  amount:            ${fmt(Number(tx.amount))} USD`);
    console.log(`  fee:               ${fmt(Number(tx.fee))} USD`);
    console.log(`  net_amount:        ${fmt(Number(tx.net_amount))} USD`);
    console.log(`  status:            ${tx.status}`);
    console.log(`  direction:         ${tx.direction}`);
    console.log(`  reference:         ${tx.reference ?? '-'}`);
    console.log(`  avada_tx_id:       ${tx.avada_transaction_id ?? '-'}`);
    console.log(`  created_at:        ${tx.created_at}`);
    console.log(`  updated_at:        ${tx.updated_at}`);
    console.log(`  metadata:          ${JSON.stringify(tx.metadata)}`);
    console.log(`  metadata.sandbox: ${(tx.metadata as Record<string, unknown>)?.sandbox ?? 'NOT SET'}`);
    console.log();

    // Fetch merchant
    const { data: merchant } = await supabase
      .from('merchants')
      .select('id, name, email, mode, kyc_status, created_at')
      .eq('id', tx.merchant_id)
      .maybeSingle();

    if (merchant) {
      console.log(`  Merchant:`);
      console.log(`    name:        ${merchant.name ?? '(no name)'}`);
      console.log(`    email:       ${merchant.email ?? '(no email)'}`);
      console.log(`    mode:        ${merchant.mode ?? 'NULL'}`);
      console.log(`    kyc_status:  ${merchant.kyc_status ?? 'NULL'}`);
      console.log(`    created_at:  ${merchant.created_at}`);
    } else {
      console.log(`  Merchant: NOT FOUND (merchant_id may be stale)`);
    }
    console.log();

    // ── 3. Check merchant_ledger_entries for this transaction ──
    const { data: ledgerEntries } = await supabase
      .from('merchant_ledger_entries')
      .select('id, merchant_id, transaction_id, type, amount, currency, balance_after, created_at')
      .eq('transaction_id', tx.id);

    const entries = ledgerEntries ?? [];
    console.log(`  Ledger entries linked to this transaction: ${entries.length}`);
    for (const e of entries) {
      console.log(`    ${e.id}  type=${e.type}  amount=${fmt(Number(e.amount))}  ${e.currency}  balance_after=${fmt(Number(e.balance_after))}  ${e.created_at}`);
    }

    const credits = entries.filter((e) => e.type === 'credit');
    if (credits.length > 0) {
      console.log(`  ⚠️  ${credits.length} CREDIT entry(ies) found — this transaction DID credit the merchant ledger.`);
      const totalCredit = credits.reduce((s, e) => s + Number(e.amount), 0);
      console.log(`     Total credited: ${fmt(totalCredit)} USD`);
    } else {
      console.log(`  ✓  No credit entries — ledger was NOT affected by this transaction.`);
    }
    console.log();

    // ── 4. Check settlements for this merchant (success status) ──
    const { data: settlements } = await supabase
      .from('merchant_settlement_requests')
      .select('id, merchant_id, amount, currency, status, phone, provider_ref, created_at, updated_at')
      .eq('merchant_id', tx.merchant_id)
      .order('created_at', { ascending: false });

    const allSettl = settlements ?? [];
    console.log(`  Settlement requests for this merchant: ${allSettl.length}`);
    for (const s of allSettl) {
      console.log(`    ${s.id}  ${fmt(Number(s.amount))} ${s.currency}  status=${s.status}  ${s.created_at}  phone=${s.phone}  ref=${s.provider_ref ?? '-'}`);
    }

    const successSettl = allSettl.filter((s) => s.status === 'success');
    const usdSuccess = successSettl.filter((s) => s.currency === 'USD');
    if (usdSuccess.length > 0) {
      const totalUsdPaid = usdSuccess.reduce((s, x) => s + Number(x.amount), 0);
      console.log(`  ⚠️  ${usdSuccess.length} USD settlement(s) with status 'success' — total paid: ${fmt(totalUsdPaid)} USD`);
      if (credits.length > 0) {
        const totalCredit = credits.reduce((s, e) => s + Number(e.amount), 0);
        console.log(`     The test transaction credited ${fmt(totalCredit)} USD to the ledger.`);
        console.log(`     If settlements were paid from this balance, real money may have been sent for a test transaction.`);
      }
    } else {
      console.log(`  ✓  No USD settlements with status 'success' — no real money was paid out for this merchant.`);
    }
    console.log();

    // ── 5. Check the merchant's current ledger balance ──
    const { data: allLedger } = await supabase
      .from('merchant_ledger_entries')
      .select('type, amount, currency')
      .eq('merchant_id', tx.merchant_id)
      .eq('currency', 'USD');

    const ledger = allLedger ?? [];
    const totalCredits = ledger.filter((e) => e.type === 'credit').reduce((s, e) => s + Number(e.amount), 0);
    const totalSettlements = ledger.filter((e) => e.type === 'settlement').reduce((s, e) => s + Number(e.amount), 0);
    const balance = totalCredits - totalSettlements;
    console.log(`  Current USD ledger balance for this merchant:`);
    console.log(`    total_credits:     ${fmt(totalCredits)} USD`);
    console.log(`    total_settlements: ${fmt(totalSettlements)} USD`);
    console.log(`    balance (owed):    ${fmt(balance)} USD`);
    console.log();
  }

  // ── Summary & recommendation ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SUMMARY & RECOMMENDATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('Option A: Mark the transaction with metadata.sandbox = true (retroactive)');
  console.log('  - Makes it disappear from "Live uniquement" revenue stats');
  console.log('  - Does NOT touch the ledger or settlements');
  console.log('  - If the ledger was credited, the credit remains (balance stays inflated)');
  console.log('  - Safest if no settlement was paid, or if you want to preserve ledger integrity');
  console.log();
  console.log('Option B: Delete the transaction AND its ledger entry');
  console.log('  - More radical — removes the fake credit from the ledger');
  console.log('  - RISKY if a settlement was already paid against this balance');
  console.log('  - Only safe if NO settlement has been paid, or if you manually reconcile');
  console.log();
  console.log('NOTE: The revenue page filters by merchants.mode, not by metadata.sandbox.');
  console.log('      If the merchant is currently in "live" mode, the transaction will');
  console.log('      still appear in "Live uniquement" even with metadata.sandbox=true.');
  console.log('      To fully exclude it from revenue stats, either:');
  console.log('      (a) set the merchant to sandbox mode (if it is a test account), or');
  console.log('      (b) mark metadata.sandbox=true AND update the revenue query to also');
  console.log('          filter by metadata->>sandbox (currently it only filters by merchant mode).');
  console.log();
  console.log('=== Diagnostic complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
