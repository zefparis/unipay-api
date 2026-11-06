import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(process.cwd() + '/package.json');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const deadline = Date.now() + 15 * 60 * 1000;
while (Date.now() < deadline) {
  const { data } = await s.from('merchant_settlement_requests')
    .select('id,status,reject_reason,updated_at,reconcile_attempted_at')
    .eq('id', '590aab8a-1b7f-4d3b-9aaa-3aee1155486f').maybeSingle();
  const { data: credits } = await s.from('merchant_ledger_entries')
    .select('type,amount,currency,balance_after,created_at')
    .eq('merchant_id', '9c3e78bd-2292-47b2-8c01-3328cf55d84f')
    .eq('type', 'credit').gte('created_at', '2026-09-16T16:00:00Z');
  console.log(new Date().toISOString(), 'status=', data?.status, 'reconcile_at=', data?.reconcile_attempted_at, 'new_credits=', JSON.stringify(credits ?? []));
  if (data?.status === 'failed' || data?.status === 'success') break;
  await new Promise(r => setTimeout(r, 90_000));
}
