import 'dotenv/config';
import { createRequire } from 'module';
const require = createRequire(process.cwd() + '/package.json');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const { data, error } = await s.rpc('claim_pending_settlements', {
  p_min_age_seconds: 300,
  p_max_age_seconds: 604800,
  p_batch_size: 50,
  p_retry_after_seconds: 300,
});
console.log('error:', JSON.stringify(error));
console.log('data:', JSON.stringify(data, null, 2));
