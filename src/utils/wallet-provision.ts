import type { SupabaseClient } from '@supabase/supabase-js';
import { generateWallet, encryptPrivateKey } from '../services/blockchain';
import { createUserWallet } from '../services/cdp';

export interface WalletRow {
  id: string;
  phone: string;
  is_active: boolean;
  cglt_balance: number;
  blockchain_address: string | null;
  balance_cdf: number;
  usdt_balance: number;
  usd_balance: number;
  lang: string | null;
}

/**
 * Find an existing wallet_users row by phone, or lazily create one if absent.
 *
 * This mirrors the exact creation logic from POST /v1/wallet/register:
 *   - generates an on-chain wallet (ethers)
 *   - encrypts the private key
 *   - inserts with cglt_balance = 0, is_active = true
 *   - fires-and-forgets CDP wallet provisioning
 *
 * Race-condition safe: if a concurrent insert triggers a UNIQUE violation
 * on phone, we re-fetch the row created by the other request.
 */
export async function findOrCreateWalletByPhone(
  supabase: SupabaseClient,
  phone: string,
  log?: { info: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<WalletRow | null> {
  // 1. Try to find an existing wallet
  const { data: existing, error: fetchErr } = await supabase
    .from('wallet_users')
    .select('id, phone, is_active, cglt_balance, blockchain_address, balance_cdf, usdt_balance, usd_balance, lang')
    .eq('phone', phone)
    .maybeSingle();

  if (fetchErr) {
    log?.error({ err: fetchErr, phone }, '[provision] lookup failed');
    return null;
  }

  if (existing) {
    return existing as WalletRow;
  }

  // 2. Not found — create a new wallet_users row (same logic as auth.ts register)
  const blockchainWallet = generateWallet();
  const encryptedPrivateKey = encryptPrivateKey(blockchainWallet.privateKey);

  const { data: created, error: insertErr } = await supabase
    .from('wallet_users')
    .insert({
      phone,
      pin_hash: '',
      blockchain_address: blockchainWallet.address,
      blockchain_private_key_encrypted: encryptedPrivateKey,
      cglt_balance: 0,
      balance_cdf: 0,
      is_active: true,
    })
    .select('id, phone, is_active, cglt_balance, blockchain_address, balance_cdf, usdt_balance, usd_balance, lang')
    .single();

  if (insertErr) {
    // Race condition: another concurrent request inserted the same phone first.
    // Re-fetch the row created by the winner.
    if (insertErr.code === '23505') {
      const { data: refetched } = await supabase
        .from('wallet_users')
        .select('id, phone, is_active, cglt_balance, blockchain_address, balance_cdf, usdt_balance, usd_balance, lang')
        .eq('phone', phone)
        .maybeSingle();
      if (refetched) {
        log?.info({ walletId: refetched.id, phone }, '[provision] wallet already existed (race refetch)');
        return refetched as WalletRow;
      }
    }
    log?.error({ err: insertErr, phone }, '[provision] insert failed');
    return null;
  }

  log?.info({ walletId: created.id, phone }, '[provision] wallet lazily created');

  // 3. Fire-and-forget CDP wallet provisioning (same as auth.ts register)
  if (process.env.CDP_API_KEY_ID) {
    createUserWallet(created.id)
      .then((cdpAddress) => {
        return supabase
          .from('wallet_users')
          .update({ cdp_wallet_address: cdpAddress })
          .eq('id', created.id);
      })
      .then(({ error: cdpErr }) => {
        if (cdpErr) log?.error({ err: cdpErr, walletId: created.id }, '[provision] CDP address save failed');
        else log?.info({ walletId: created.id }, '[provision] CDP wallet address saved');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log?.error({ err, walletId: created.id }, '[provision] CDP wallet creation failed: ' + msg);
      });
  }

  return created as WalletRow;
}
