/**
 * Verification script: check for existing non-CDF/USDT merchant transactions.
 *
 * Usage:
 *   npx tsx scripts/check-merchant-currencies.ts
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (loaded via src/config/env).
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // 1. Count non-CDF/USDT merchant transactions
  const { data: countData, error: countError } = await supabase
    .from('transactions')
    .select('id, currency, merchant_id, amount, direction, operator, status, created_at', { count: 'exact' })
    .not('merchant_id', 'is', null)
    .not('currency', 'in', '("CDF","USDT")');

  if (countError) {
    console.error('Query failed:', countError);
    process.exit(1);
  }

  console.log('=== Non-CDF/USDT merchant transactions ===');
  console.log(`Count: ${countData?.length ?? 0}`);
  if (countData && countData.length > 0) {
    console.table(countData);
  }

  // 2. Breakdown of all currencies used by merchant transactions
  const { data: allMerchant, error: allError } = await supabase
    .from('transactions')
    .select('currency, merchant_id, amount, direction')
    .not('merchant_id', 'is', null);

  if (allError) {
    console.error('Full query failed:', allError);
    process.exit(1);
  }

  const byCurrency: Record<string, number> = {};
  for (const tx of allMerchant ?? []) {
    const c = (tx as { currency: string }).currency;
    byCurrency[c] = (byCurrency[c] ?? 0) + 1;
  }

  console.log('\n=== All merchant transactions by currency ===');
  console.table(byCurrency);

  // 3. Check merchant_ledger_entries for currency column existence
  const { data: ledgerSample, error: ledgerError } = await supabase
    .from('merchant_ledger_entries')
    .select('*')
    .limit(1);

  if (ledgerError) {
    console.log('\n=== merchant_ledger_entries ===');
    console.log('Error (column may not exist yet):', ledgerError.message);
  } else {
    console.log('\n=== merchant_ledger_entries sample ===');
    console.log('Columns:', ledgerSample?.length ? Object.keys(ledgerSample[0]) : 'no rows');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
