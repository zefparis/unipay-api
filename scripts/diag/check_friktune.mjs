import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(process.cwd() + '/package.json');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data: stl } = await s.from('merchant_settlement_requests')
  .select('id,status,reject_reason,provider_ref,updated_at,reconcile_attempted_at')
  .eq('id', '590aab8a-1b7f-4d3b-9aaa-3aee1155486f').maybeSingle();
console.log('settlement:', JSON.stringify(stl, null, 2));

const { data: ledger } = await s.from('merchant_ledger_entries')
  .select('id,type,amount,currency,balance_after,created_at')
  .eq('merchant_id', '9c3e78bd-2292-47b2-8c01-3328cf55d84f')
  .eq('currency', 'CDF')
  .order('created_at', { ascending: false }).limit(5);
console.log('recent CDF ledger:', JSON.stringify(ledger, null, 2));

const { data: ev } = await s.from('provider_webhook_events')
  .select('provider_event_id, payload, processed_at')
  .order('processed_at', { ascending: false }).limit(3);
console.log('latest webhook events:', JSON.stringify(ev, null, 2));
