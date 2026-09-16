import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';
async function main() {
  const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: all, error } = await s.from('merchant_ledger_entries')
    .select('merchant_id, currency');
  if (error) { console.error(error); process.exit(1); }
  const byMerch = new Map<string, Set<string>>();
  for (const e of all ?? []) {
    if (!byMerch.has(e.merchant_id)) byMerch.set(e.merchant_id, new Set());
    byMerch.get(e.merchant_id)!.add(e.currency);
  }
  const multi = [...byMerch.entries()].filter(([, c]) => c.size > 1);
  const { data: ms } = await s.from('merchants').select('id,name').in('id', multi.map(([m]) => m).length ? multi.map(([m]) => m) : ['00000000-0000-0000-0000-000000000000']);
  const nm = new Map((ms ?? []).map(m => [m.id, m.name]));
  console.log(`Merchants with multi-currency ledger (all-time): ${multi.length}`);
  for (const [m, cs] of multi) console.log(` ${nm.get(m) ?? m}: ${[...cs].join(', ')}`);
  console.log(`\nTotal merchants with any ledger: ${byMerch.size}`);
}
main().catch(e => { console.error(e); process.exit(1); });
