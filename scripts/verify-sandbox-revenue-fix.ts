/**
 * READ-ONLY diagnostic + fix script for the sandbox/live revenue classification.
 *
 * Step 1: Verify merchant 04533243 (hcs-u7) has no real live transactions
 *         before switching its mode to 'sandbox'.
 * Step 2: Scan ALL live merchants for transactions with metadata.sandbox=true
 *         or metadata.dashboard_test=true — to see if this is an isolated case.
 *
 * This script is READ-ONLY — it does not modify any data.
 * After review, the mode switch and code fix are applied separately.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx tsx scripts/verify-sandbox-revenue-fix.ts
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

const TARGET_MERCHANT_ID = '04533243-64f2-428f-9eca-abd16302ca78';

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

async function main() {
  console.log('=== Verify sandbox revenue fix ===\n');

  // ── 1. Verify target merchant ──
  console.log('1. Target merchant 04533243 (hcs-u7):');
  const { data: merchant } = await supabase
    .from('merchants')
    .select('id, name, email, mode, kyc_status, created_at')
    .eq('id', TARGET_MERCHANT_ID)
    .maybeSingle();

  if (!merchant) {
    console.log('   Merchant NOT FOUND — aborting.');
    return;
  }
  console.log(`   name:       ${merchant.name ?? '(no name)'}`);
  console.log(`   email:      ${merchant.email ?? '(no email)'}`);
  console.log(`   mode:       ${merchant.mode ?? 'NULL'}`);
  console.log(`   kyc_status: ${merchant.kyc_status ?? 'NULL'}`);
  console.log(`   created_at: ${merchant.created_at}`);
  console.log();

  // ── 2. List ALL transactions for this merchant ──
  console.log('2. All transactions for this merchant:');
  const { data: allTxs } = await supabase
    .from('transactions')
    .select('id, direction, amount, fee, net_amount, currency, status, metadata, created_at')
    .eq('merchant_id', TARGET_MERCHANT_ID)
    .order('created_at', { ascending: false });

  const txs = allTxs ?? [];
  console.log(`   Total: ${txs.length} transactions`);
  for (const t of txs) {
    const meta = t.metadata as Record<string, unknown> | null;
    const isSandbox = meta?.sandbox === true || meta?.dashboard_test === true;
    console.log(
      `   ${t.id}  dir=${t.direction}  ${fmt(Number(t.amount))} ${t.currency}  status=${t.status}  sandbox=${isSandbox ? 'YES' : 'no'}  ${t.created_at}`,
    );
  }

  const realLiveTxs = txs.filter((t) => {
    const meta = t.metadata as Record<string, unknown> | null;
    return !(meta?.sandbox === true || meta?.dashboard_test === true);
  });
  console.log(`\n   Transactions WITHOUT sandbox/dashboard_test flag: ${realLiveTxs.length}`);
  if (realLiveTxs.length > 0) {
    console.log('   ⚠️  This merchant has transactions that are NOT marked sandbox:');
    for (const t of realLiveTxs) {
      console.log(`      ${t.id}  ${fmt(Number(t.amount))} ${t.currency}  status=${t.status}  ${t.created_at}`);
    }
    console.log('   → Review these before switching the merchant to sandbox mode.');
  } else {
    console.log('   ✓  All transactions are sandbox/dashboard_test — safe to switch merchant to sandbox mode.');
  }
  console.log();

  // ── 3. Scan ALL live merchants for sandbox/dashboard_test transactions ──
  console.log('3. Scanning ALL live merchants for sandbox/dashboard_test transactions:');
  const { data: liveMerchants } = await supabase
    .from('merchants')
    .select('id, name, email, mode')
    .eq('mode', 'live')
    .order('name');

  const live = liveMerchants ?? [];
  console.log(`   ${live.length} merchants in 'live' mode`);
  console.log();

  let contaminatedCount = 0;
  for (const m of live) {
    // Fetch transactions for this merchant with metadata.sandbox=true
    const { data: sandboxTxs } = await supabase
      .from('transactions')
      .select('id, direction, amount, currency, status, metadata, created_at')
      .eq('merchant_id', m.id)
      .filter('metadata->>sandbox', 'eq', 'true')
      .order('created_at', { ascending: false });

    // Also check metadata.dashboard_test=true
    const { data: dashboardTxs } = await supabase
      .from('transactions')
      .select('id, direction, amount, currency, status, metadata, created_at')
      .eq('merchant_id', m.id)
      .filter('metadata->>dashboard_test', 'eq', 'true')
      .order('created_at', { ascending: false });

    const sb = (sandboxTxs ?? []) as Record<string, unknown>[];
    const dt = (dashboardTxs ?? []) as Record<string, unknown>[];
    // Merge unique
    const sbIds = sb.map((t) => t.id as string);
    const dtIds = dt.map((t) => t.id as string);
    const allIds = Array.from(new Set<string>([...sbIds, ...dtIds]));
    const contaminated = allIds.map((id) => {
      return sb.find((t) => t.id === id) ?? dt.find((t) => t.id === id);
    }).filter(Boolean) as Record<string, unknown>[];

    if (contaminated.length > 0) {
      contaminatedCount++;
      console.log(`   ⚠️  ${m.name ?? '(no name)'} [${m.id}]  mode=${m.mode}`);
      console.log(`      ${contaminated.length} sandbox/dashboard_test transaction(s):`);
      for (const t of contaminated) {
        console.log(`      ${t.id}  dir=${t.direction}  ${fmt(Number(t.amount))} ${t.currency}  status=${t.status}  ${t.created_at}`);
      }
    }
  }

  if (contaminatedCount === 0) {
    console.log('   ✓  No live merchant has sandbox/dashboard_test transactions.');
  } else {
    console.log(`\n   ${contaminatedCount} live merchant(s) have sandbox/dashboard_test transactions.`);
    console.log('   These transactions appear in "Live uniquement" because the revenue');
    console.log('   query filters by merchants.mode, not by metadata.sandbox.');
  }
  console.log();

  // ── 4. Summary ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log(`Target merchant (hcs-u7): ${txs.length} total transactions, ${realLiveTxs.length} without sandbox flag`);
  if (realLiveTxs.length === 0) {
    console.log('  → SAFE to switch merchant to sandbox mode');
  } else {
    console.log('  → REVIEW needed: some transactions are not marked sandbox');
  }
  console.log();
  console.log(`Live merchants with sandbox transactions: ${contaminatedCount}`);
  console.log();
  console.log('FIX PLAN:');
  console.log('  1. Switch merchant 04533243 to sandbox mode (if all txs are sandbox/test)');
  console.log('  2. Modify revenue query to also filter metadata->>sandbox=true');
  console.log('     (defense in depth — catches future cases)');
  console.log();
  console.log('=== Diagnostic complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
