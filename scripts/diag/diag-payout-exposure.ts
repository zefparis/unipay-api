import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';
async function main() {
  const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const ids = ['e66fc74b', 'b52c17e0', '1139e84b', '9ead3e17', 'faa8145f'];
  const { data: txs } = await s.from('transactions')
    .select('id, merchant_id, amount, currency, status, metadata, created_at, updated_at')
    .in('id', [
      // need full ids — fetch by prefix via ilike on cast? simpler: fetch all failed merchant payouts pre-0916
    ]);
  // simpler: refetch
  const { data: failed } = await s.from('transactions')
    .select('id, merchant_id, amount, currency, status, metadata, created_at, updated_at')
    .eq('direction', 'payout').not('merchant_id', 'is', null)
    .is('settlement_request_id', null).eq('status', 'failed');
  for (const t of failed ?? []) {
    const { data: ledger } = await s.from('merchant_ledger_entries')
      .select('type, amount, created_at').eq('transaction_id', t.id);
    console.log(JSON.stringify({
      tx: t.id.slice(0, 8), amount: t.amount, currency: t.currency,
      created: t.created_at, resolved: t.updated_at,
      how: t.metadata?.provider_result ? 'callback/reconcile' : (t.metadata?.failure_kind ? `initiation(${t.metadata.failure_kind})` : JSON.stringify(t.metadata).slice(0, 120)),
      ledger: ledger,
    }));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
