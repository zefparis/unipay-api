/**
 * READ-ONLY diagnostic: detect sandbox transactions that contaminated the
 * merchant ledger and were potentially paid out as real settlements.
 *
 * Hypothesis: the balance computation (sum of merchant_ledger_entries)
 * does not filter by mode (live/sandbox). If sandbox collect transactions
 * ever created a 'credit' ledger entry, that fake money would inflate the
 * merchant balance and could be paid out as a real settlement.
 *
 * Sandbox collect path (src/routes/payment/initiate.ts) inserts the
 * transaction directly with status='success' and metadata.sandbox=true,
 * WITHOUT calling process_wallet_provider_callback — so in theory the
 * ledger should NOT be credited for sandbox transactions. This script
 * verifies that assumption and quantifies any contamination.
 *
 * It also checks the reverse: a merchant who was 'live' but had sandbox
 * transactions (e.g. via x-unipay-mode header override) that somehow
 * reached the callback and credited the ledger.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx tsx scripts/check-sandbox-ledger-contamination.ts
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

const FRIKTUNE_ID = '9c3e78bd-2292-47b2-8c01-3328cf55d84f';

interface Merchant {
  id: string;
  name: string | null;
  mode: string | null;
}

interface LedgerEntry {
  id: string;
  merchant_id: string;
  transaction_id: string | null;
  type: string;
  amount: number;
  currency: string;
  created_at: string;
}

interface Transaction {
  id: string;
  merchant_id: string;
  direction: string;
  amount: number;
  net_amount: number;
  currency: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface SettlementRequest {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

async function main() {
  console.log('=== Sandbox ledger contamination diagnostic ===\n');

  // ── 1. Schema check: does transactions have a mode/is_sandbox column? ──
  console.log('1. Schema check (transactions columns):');
  // exec_sql RPC likely doesn't exist; infer from a sample row
  const { data: sampleTx, error: sampleErr } = await supabase
    .from('transactions')
    .select('*')
    .limit(1);
  if (sampleErr) {
    console.log('   Could not read transactions:', sampleErr.message);
  } else if (sampleTx && sampleTx.length > 0) {
    const keys = Object.keys(sampleTx[0]);
    const hasMode = keys.includes('mode');
    const hasIsSandbox = keys.includes('is_sandbox');
    console.log('   transactions columns:', keys.join(', '));
    console.log('   has mode column:', hasMode);
    console.log('   has is_sandbox column:', hasIsSandbox);
  } else {
    console.log('   transactions table is empty');
  }

  // Same for merchant_ledger_entries
  const { data: sampleLedger } = await supabase
    .from('merchant_ledger_entries')
    .select('*')
    .limit(1);
  if (sampleLedger && sampleLedger.length > 0) {
    const keys = Object.keys(sampleLedger[0]);
    console.log('   merchant_ledger_entries columns:', keys.join(', '));
    console.log('   has mode column:', keys.includes('mode'));
    console.log('   has is_sandbox column:', keys.includes('is_sandbox'));
  } else {
    console.log('   merchant_ledger_entries table is empty');
  }
  console.log();

  // ── 2. List all merchants with their mode ──
  console.log('2. Merchants and their mode:');
  const { data: merchants, error: mErr } = await supabase
    .from('merchants')
    .select('id, name, mode')
    .order('name');
  if (mErr) {
    console.log('   Error:', mErr.message);
    return;
  }
  for (const m of (merchants as Merchant[]) ?? []) {
    console.log(`   ${m.id}  ${m.name ?? '(no name)'}  mode=${m.mode ?? 'NULL'}`);
  }
  console.log();

  // ── 3. Find all transactions with metadata.sandbox = true ──
  console.log('3. Transactions with metadata.sandbox = true:');
  // Postgrest filter on jsonb: metadata->>sandbox = 'true'
  const { data: sandboxTxs, error: stErr } = await supabase
    .from('transactions')
    .select('id, merchant_id, direction, amount, net_amount, currency, status, metadata, created_at')
    .filter('metadata->>sandbox', 'eq', 'true')
    .order('created_at');
  if (stErr) {
    console.log('   Error:', stErr.message);
  } else {
    const txs = (sandboxTxs as Transaction[]) ?? [];
    console.log(`   Found ${txs.length} sandbox-flagged transactions`);
    const byMerchant: Record<string, { count: number; total_net: number; currencies: string[] }> = {};
    for (const t of txs) {
      if (!byMerchant[t.merchant_id]) {
        byMerchant[t.merchant_id] = { count: 0, total_net: 0, currencies: [] };
      }
      byMerchant[t.merchant_id].count++;
      if (t.direction === 'collect') {
        byMerchant[t.merchant_id].total_net += Number(t.net_amount ?? 0);
      }
      if (!byMerchant[t.merchant_id].currencies.includes(t.currency as string)) {
        byMerchant[t.merchant_id].currencies.push(t.currency as string);
      }
    }
    for (const [mid, agg] of Object.entries(byMerchant)) {
      const m = (merchants as Merchant[])?.find((x) => x.id === mid);
      console.log(
        `   ${mid}  ${m?.name ?? '(no name)'}  mode=${m?.mode ?? 'NULL'}  count=${agg.count}  net_collect=${fmt(agg.total_net)}  currencies=[${agg.currencies.join(',')}]`,
      );
    }
  }
  console.log();

  // ── 4. Cross-reference: do any ledger credit entries link to sandbox txs? ──
  console.log('4. Ledger credit entries linked to sandbox-flagged transactions:');
  const sbTxs = ((sandboxTxs as Transaction[]) ?? []).map((t) => t.id);
  if (sbTxs.length === 0) {
    console.log('   No sandbox transactions → no contamination possible via transaction_id link.');
  } else {
    // Fetch ledger entries whose transaction_id is in the sandbox tx set
    // Postgrest in_ filter
    const { data: linkedLedger, error: llErr } = await supabase
      .from('merchant_ledger_entries')
      .select('id, merchant_id, transaction_id, type, amount, currency, created_at')
      .in('transaction_id', sbTxs);
    if (llErr) {
      console.log('   Error:', llErr.message);
    } else {
      const entries = (linkedLedger as LedgerEntry[]) ?? [];
      const credits = entries.filter((e) => e.type === 'credit');
      console.log(`   ${entries.length} ledger entries link to sandbox txs (${credits.length} credits)`);
      for (const e of credits) {
        const m = (merchants as Merchant[])?.find((x) => x.id === e.merchant_id);
        console.log(
          `   CREDIT ${e.id}  merchant=${m?.name ?? e.merchant_id}  amount=${fmt(Number(e.amount))}  ${e.currency}  tx=${e.transaction_id}  ${e.created_at}`,
        );
      }
      if (credits.length === 0) {
        console.log('   → No ledger credits linked to sandbox transactions (good).');
      }
    }
  }
  console.log();

  // ── 5. For each merchant, compute balance vs settlements paid ──
  console.log('5. Per-merchant: ledger credits, settlements paid (success), and sandbox exposure:');
  console.log('   (sandbox exposure = sum of net_amount for collect txs with metadata.sandbox=true)');

  const { data: allLedger, error: alErr } = await supabase
    .from('merchant_ledger_entries')
    .select('id, merchant_id, transaction_id, type, amount, currency, created_at');
  if (alErr) {
    console.log('   Error reading ledger:', alErr.message);
    return;
  }
  const ledger = (allLedger as LedgerEntry[]) ?? [];

  const { data: allSettlements, error: asErr } = await supabase
    .from('merchant_settlement_requests')
    .select('id, merchant_id, amount, currency, status, created_at');
  if (asErr) {
    console.log('   Error reading settlements:', asErr.message);
    return;
  }
  const settlements = (allSettlements as SettlementRequest[]) ?? [];

  for (const m of (merchants as Merchant[]) ?? []) {
    const mLedger = ledger.filter((e) => e.merchant_id === m.id);
    const mCredits = mLedger.filter((e) => e.type === 'credit');
    const mSettlements = mLedger.filter((e) => e.type === 'settlement');

    const byCur: Record<string, { credits: number; settlements: number }> = {};
    for (const e of mCredits) {
      const c = e.currency ?? 'CDF';
      if (!byCur[c]) byCur[c] = { credits: 0, settlements: 0 };
      byCur[c].credits += Number(e.amount);
    }
    for (const e of mSettlements) {
      const c = e.currency ?? 'CDF';
      if (!byCur[c]) byCur[c] = { credits: 0, settlements: 0 };
      byCur[c].settlements += Number(e.amount);
    }

    // Sandbox exposure for this merchant
    const mSandboxTxs = ((sandboxTxs as Transaction[]) ?? []).filter((t) => t.merchant_id === m.id && t.direction === 'collect');
    const sandboxByCur: Record<string, number> = {};
    for (const t of mSandboxTxs) {
      const c = t.currency ?? 'CDF';
      sandboxByCur[c] = (sandboxByCur[c] ?? 0) + Number(t.net_amount ?? 0);
    }

    // Settlements with status success for this merchant
    const mSuccessSettlements = settlements.filter((s) => s.merchant_id === m.id && s.status === 'success');
    const successByCur: Record<string, number> = {};
    for (const s of mSuccessSettlements) {
      const c = s.currency ?? 'CDF';
      successByCur[c] = (successByCur[c] ?? 0) + Number(s.amount);
    }

    const hasSandbox = Object.keys(sandboxByCur).length > 0;
    const hasLedger = mLedger.length > 0;
    if (!hasSandbox && !hasLedger) continue; // skip merchants with nothing

    console.log(`\n   ${m.name ?? '(no name)'}  [${m.id}]  mode=${m.mode ?? 'NULL'}`);
    for (const c of Object.keys(byCur)) {
      const v = byCur[c];
      console.log(`     ${c}: credits=${fmt(v.credits)}  settlements=${fmt(v.settlements)}  balance=${fmt(v.credits - v.settlements)}`);
    }
    if (Object.keys(successByCur).length > 0) {
      console.log(`     settlements_paid_success: ${JSON.stringify(successByCur)}`);
    }
    if (hasSandbox) {
      console.log(`     SANDBOX collect net_amount by currency: ${JSON.stringify(sandboxByCur)}`);
      // The key question: did sandbox collect txs create ledger credits?
      // Check if any of this merchant's ledger credits link to their sandbox txs
      const mSandboxTxIds = new Set(mSandboxTxs.map((t) => t.id));
      const linkedCredits = mCredits.filter((e) => e.transaction_id && mSandboxTxIds.has(e.transaction_id));
      if (linkedCredits.length > 0) {
        console.log(`     ⚠️  ${linkedCredits.length} ledger CREDITS linked to sandbox transactions:`);
        for (const e of linkedCredits) {
          console.log(`        ${e.id}  ${fmt(Number(e.amount))} ${e.currency}  tx=${e.transaction_id}  ${e.created_at}`);
        }
      } else {
        console.log(`     ✓  No ledger credits directly linked to sandbox txs (transaction_id match)`);
      }
    }
  }
  console.log();

  // ── 6. Deep dive: Friktune ──
  console.log('6. Friktune deep dive:');
  const { data: frikLedger } = await supabase
    .from('merchant_ledger_entries')
    .select('id, merchant_id, transaction_id, type, amount, currency, created_at')
    .eq('merchant_id', FRIKTUNE_ID)
    .order('created_at');
  const frikEntries = (frikLedger as LedgerEntry[]) ?? [];
  console.log(`   ${frikEntries.length} ledger entries for Friktune`);

  const { data: frikTxs } = await supabase
    .from('transactions')
    .select('id, merchant_id, direction, amount, net_amount, currency, status, metadata, created_at')
    .eq('merchant_id', FRIKTUNE_ID)
    .order('created_at');
  const frikTransactions = (frikTxs as Transaction[]) ?? [];
  console.log(`   ${frikTransactions.length} transactions for Friktune`);

  const frikSandbox = frikTransactions.filter((t) => t.metadata?.sandbox === true);
  console.log(`   ${frikSandbox.length} sandbox-flagged transactions`);
  const frikSandboxCollect = frikSandbox.filter((t) => t.direction === 'collect');
  const frikSandboxNet = frikSandboxCollect.reduce((s, t) => s + Number(t.net_amount ?? 0), 0);
  console.log(`   sandbox collect net_amount total: ${fmt(frikSandboxNet)}`);

  const frikCredits = frikEntries.filter((e) => e.type === 'credit');
  console.log(`   ${frikCredits.length} ledger credits`);
  const frikCreditsTotal = frikCredits.reduce((s, e) => s + Number(e.amount), 0);
  console.log(`   ledger credits total: ${fmt(frikCreditsTotal)}`);

  // Check each credit: is it linked to a sandbox tx?
  const frikSandboxTxIds = new Set(frikSandbox.map((t) => t.id));
  const frikContaminated = frikCredits.filter((e) => e.transaction_id && frikSandboxTxIds.has(e.transaction_id));
  console.log(`   credits linked to sandbox txs: ${frikContaminated.length}`);
  if (frikContaminated.length > 0) {
    console.log('   ⚠️  CONTAMINATION CONFIRMED:');
    for (const e of frikContaminated) {
      console.log(`      ${e.id}  ${fmt(Number(e.amount))} ${e.currency}  tx=${e.transaction_id}  ${e.created_at}`);
    }
  }

  // Settlements paid
  const { data: frikSettlements } = await supabase
    .from('merchant_settlement_requests')
    .select('id, merchant_id, amount, currency, status, phone, provider_ref, created_at, updated_at')
    .eq('merchant_id', FRIKTUNE_ID)
    .order('created_at');
  const frikSettl = (frikSettlements as (SettlementRequest & { phone: string; provider_ref: string | null; updated_at: string })[]) ?? [];
  console.log(`\n   ${frikSettl.length} settlement requests for Friktune:`);
  for (const s of frikSettl) {
    console.log(`      ${s.id}  ${fmt(s.amount)} ${s.currency}  status=${s.status}  ${s.created_at}  phone=${s.phone}  ref=${s.provider_ref ?? '-'}`);
  }

  const frikSuccess = frikSettl.filter((s) => s.status === 'success');
  const frikSuccessByCur: Record<string, number> = {};
  for (const s of frikSuccess) {
    const c = s.currency ?? 'CDF';
    frikSuccessByCur[c] = (frikSuccessByCur[c] ?? 0) + Number(s.amount);
  }
  console.log(`\n   Total paid out (success settlements): ${JSON.stringify(frikSuccessByCur)}`);

  // If contamination exists, quantify how much of the paid-out amount
  // corresponds to sandbox credits
  if (frikContaminated.length > 0) {
    const contaminatedByCur: Record<string, number> = {};
    for (const e of frikContaminated) {
      const c = e.currency ?? 'CDF';
      contaminatedByCur[c] = (contaminatedByCur[c] ?? 0) + Number(e.amount);
    }
    console.log(`\n   ⚠️  Sandbox credits that entered the ledger by currency: ${JSON.stringify(contaminatedByCur)}`);
    console.log('   These amounts were counted in the balance and may have been paid out as real money.');
    for (const c of Object.keys(contaminatedByCur)) {
      const paid = frikSuccessByCur[c] ?? 0;
      const contaminated = contaminatedByCur[c];
      console.log(`      ${c}: contaminated credits=${fmt(contaminated)}, total paid out=${fmt(paid)}`);
      if (contaminated > 0 && paid > 0) {
        console.log(`      → Up to ${fmt(Math.min(contaminated, paid))} ${c} may have been paid as real money for sandbox (test) transactions.`);
      }
    }
  } else {
    console.log('\n   ✓ No direct transaction_id link between sandbox txs and ledger credits.');
    console.log('   Checking if sandbox txs could have been credited via callback (status=success without sandbox metadata on ledger)...');

    // Alternative: maybe the callback was called for sandbox txs anyway.
    // Check: are there ledger credits for Friktune with NO transaction_id link
    // to any transaction, or linked to a sandbox tx?
    const frikAllTxIds = new Set(frikTransactions.map((t) => t.id));
    const creditsWithUnknownTx = frikCredits.filter((e) => e.transaction_id && !frikAllTxIds.has(e.transaction_id));
    if (creditsWithUnknownTx.length > 0) {
      console.log(`   ${creditsWithUnknownTx.length} credits link to unknown transactions (possibly deleted):`);
      for (const e of creditsWithUnknownTx) {
        console.log(`      ${e.id}  ${fmt(Number(e.amount))} ${e.currency}  tx=${e.transaction_id}  ${e.created_at}`);
      }
    }
  }

  console.log('\n=== Diagnostic complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
