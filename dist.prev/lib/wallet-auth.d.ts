import type { SupabaseClient } from '@supabase/supabase-js';
import { type WalletJwtPayload } from '../utils/wallet-jwt.js';
/**
 * Extract and verify the wallet JWT from the Authorization header.
 * Returns the payload (containing wallet_id) or null.
 */
export declare function requireWalletAuth(request: {
    headers: Record<string, string | string[] | undefined>;
}): WalletJwtPayload | null;
/**
 * Extract wallet_id from JWT (for use in rate-limit keyGenerator
 * where we only need the ID, not a full DB lookup).
 */
export declare function walletIdFromRequest(request: {
    headers: Record<string, string | string[] | undefined>;
}): string;
/**
 * Verify the wallet JWT AND check that wallet_users.is_active is true.
 * Returns:
 *   { ok: true, payload, wallet }     — wallet is active, DB row included
 *   { ok: false, status, error }      — send this reply (already coded)
 *
 * Usage in a route handler:
 *   const auth = await requireActiveWallet(request, fastify.supabase);
 *   if (!auth.ok) return reply.status(auth.status).send(auth.error);
 *   const walletId = auth.payload.wallet_id;
 *   const wallet   = auth.wallet; // { id, phone, is_active, kyc_level, ... }
 *
 * The `select` parameter lets callers pull additional columns they need
 * (e.g. 'balance_cdf, usd_balance, cglt_balance') in the same DB round-trip.
 */
export declare function requireActiveWallet(request: {
    headers: Record<string, string | string[] | undefined>;
}, supabase: SupabaseClient, select?: string): Promise<{
    ok: true;
    payload: WalletJwtPayload;
    wallet: Record<string, unknown>;
} | {
    ok: false;
    status: number;
    error: {
        error: string;
        statusCode: number;
    };
}>;
