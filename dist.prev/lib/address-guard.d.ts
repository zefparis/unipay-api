/**
 * Shared BSC destination address guard.
 *
 * Single source of truth for FORBIDDEN_ADDRESSES and the contract-detection
 * check used by every route that sends tokens to a user-supplied BSC address
 * (crypto-withdraw, cglt-gaming, wcglt-swap).
 *
 * Re-exported `isContractAddress` comes from bsc-withdrawal to avoid a second
 * ethers provider instantiation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
export declare const FORBIDDEN_ADDRESSES: Set<string>;
export declare const EVM_ADDR: RegExp;
/**
 * Result of a destination address check.
 * - `ok: true`  → address is safe to send to.
 * - `ok: false` → `status` and `body` describe the rejection to return.
 */
export type AddressGuardResult = {
    ok: true;
} | {
    ok: false;
    status: 400;
    body: {
        error: string;
        message: string;
    };
} | {
    ok: false;
    status: 503;
    body: {
        error: string;
    };
};
/**
 * Validates a BSC destination address end-to-end:
 *  1. format (0x + 40 hex)
 *  2. FORBIDDEN_ADDRESSES (token contracts, zero address)
 *  3. on-chain contract detection (skipped if address is whitelisted)
 *
 * @param address      Raw destination address as submitted by the client.
 * @param supabase     Supabase client (or fastify.supabase) for the whitelist
 *                     lookup. Pass `null` to skip the whitelist (contract
 *                     detection runs unconditionally).
 */
export declare function checkDestinationAddress(address: string, supabase: SupabaseClient | null): Promise<AddressGuardResult>;
