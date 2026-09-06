/**
 * One-off script: regenerate all merchant API keys.
 *
 * Background: every API key created via /merchant/register was hashed with
 * bcrypt but verified with SHA-256 (hmac.ts), so no merchant could ever
 * authenticate. This script regenerates a new key for every merchant that
 * still has an active key, using the now-coherent format (bcrypt hash +
 * 12-char prefix).
 *
 * Usage:
 *   npx tsx scripts/regenerate-merchant-api-keys.ts
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY (loaded via src/config/env).
 *
 * Output: JSON array on stdout with { merchant_id, email, name, new_api_key }.
 *   ⚠️  This output contains plaintext API keys — redirect to a secure file,
 *   transmit to the operator out-of-band, and delete after distribution.
 *   NEVER commit this output or log it persistently.
 *
 * The script does NOT send emails — manual distribution is intentional.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env';

interface MerchantRow {
  id: string;
  name: string;
  email: string;
}

interface RegenerationReport {
  merchant_id: string;
  name: string;
  email: string;
  new_api_key: string;
  key_prefix: string;
  old_key_deactivated: boolean;
}

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // 1. List all merchants that have at least one active API key.
  const { data: activeKeys, error: keysError } = await supabase
    .from('api_keys')
    .select('merchant_id')
    .eq('is_active', true);

  if (keysError) {
    console.error('Failed to query active api_keys:', keysError.message);
    process.exit(1);
  }

  const merchantIds = [...new Set((activeKeys ?? []).map((k) => k.merchant_id as string))];
  if (merchantIds.length === 0) {
    console.error('No merchants with active API keys found.');
    process.exit(0);
  }

  // 2. Fetch merchant details.
  const { data: merchants, error: merchantsError } = await supabase
    .from('merchants')
    .select('id, name, email')
    .in('id', merchantIds)
    .order('email', { ascending: true });

  if (merchantsError || !merchants) {
    console.error('Failed to query merchants:', merchantsError?.message);
    process.exit(1);
  }

  const report: RegenerationReport[] = [];

  for (const m of merchants as MerchantRow[]) {
    // 3. Deactivate all existing active keys for this merchant.
    const { error: deactivateError } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('merchant_id', m.id)
      .eq('is_active', true);

    const deactivated = !deactivateError;
    if (deactivateError) {
      console.error(`[merchant ${m.id}] deactivate failed: ${deactivateError.message}`);
    }

    // 4. Generate new key: up_<32 random hex> (same format as register.ts).
    const rawKey = `up_${crypto.randomBytes(16).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 12);
    const keyHash = await bcrypt.hash(rawKey, 10);

    const { error: insertError } = await supabase.from('api_keys').insert({
      merchant_id: m.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      label: 'regenerated',
      is_active: true,
    });

    if (insertError) {
      console.error(`[merchant ${m.id}] insert new key failed: ${insertError.message}`);
      continue;
    }

    report.push({
      merchant_id: m.id,
      name: m.name,
      email: m.email,
      new_api_key: rawKey,
      key_prefix: keyPrefix,
      old_key_deactivated: deactivated,
    });

    console.error(`[OK] ${m.email} — new key generated (prefix ${keyPrefix})`);
  }

  // 5. Output JSON report on stdout (separate from progress logs on stderr).
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nDone. ${report.length} merchant(s) regenerated.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
