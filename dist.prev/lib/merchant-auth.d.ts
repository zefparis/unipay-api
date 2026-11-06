import type { SupabaseClient } from '@supabase/supabase-js';
import { type JwtPayload } from '../utils/jwt.js';
/**
 * Extract and verify the JWT from the Authorization header.
 * Returns the payload (containing merchant_id) or null.
 */
export declare function requireMerchantAuth(request: {
    headers: Record<string, string | string[] | undefined>;
}): JwtPayload | null;
/**
 * Extract merchant_id from JWT (for use in rate-limit keyGenerator
 * where we only need the ID, not a full DB lookup).
 */
export declare function merchantIdFromRequest(request: {
    headers: Record<string, string | string[] | undefined>;
}): string | null;
/**
 * Verify the JWT AND check that the merchant's status is 'active'.
 * Returns:
 *   { ok: true, payload }        — merchant is active
 *   { ok: false, reply, status } — send this reply (already coded)
 *
 * Usage in a route handler:
 *   const auth = await requireActiveMerchant(request, fastify.supabase);
 *   if (!auth.ok) return reply.status(auth.status).send(auth.error);
 *   const merchantId = auth.payload.merchant_id;
 */
/**
 * Session marchand valide SANS gate de statut : JWT vérifié + merchant
 * existant + token_version à jour. Utilisée pour les routes accessibles
 * même en suspension KYC (soumission KYC, consultation du dossier).
 */
export declare function requireMerchantSession(request: {
    headers: Record<string, string | string[] | undefined>;
}, supabase: SupabaseClient): Promise<{
    ok: true;
    payload: JwtPayload;
} | {
    ok: false;
    status: 401 | 404;
    error: {
        error: string;
        statusCode: number;
    };
}>;
export declare function requireActiveMerchant(request: {
    headers: Record<string, string | string[] | undefined>;
}, supabase: SupabaseClient): Promise<{
    ok: true;
    payload: JwtPayload;
} | {
    ok: false;
    status: 401 | 403 | 404;
    error: {
        error: string;
        statusCode: number;
    };
}>;
