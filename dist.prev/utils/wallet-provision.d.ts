import type { SupabaseClient } from '@supabase/supabase-js';
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
export declare function findOrCreateWalletByPhone(supabase: SupabaseClient, phone: string, log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<WalletRow | null>;
