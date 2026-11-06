"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireWalletAuth = requireWalletAuth;
exports.walletIdFromRequest = walletIdFromRequest;
exports.requireActiveWallet = requireActiveWallet;
const wallet_jwt_js_1 = require("../utils/wallet-jwt.js");
const env_js_1 = require("../config/env.js");
/**
 * Extract and verify the wallet JWT from the Authorization header.
 * Returns the payload (containing wallet_id) or null.
 */
function requireWalletAuth(request) {
    if (!env_js_1.env.JWT_SECRET)
        return null;
    const auth = request.headers.authorization;
    return (0, wallet_jwt_js_1.requireWallet)(typeof auth === 'string' ? auth : undefined, env_js_1.env.JWT_SECRET);
}
/**
 * Extract wallet_id from JWT (for use in rate-limit keyGenerator
 * where we only need the ID, not a full DB lookup).
 */
function walletIdFromRequest(request) {
    const payload = requireWalletAuth(request);
    return payload?.wallet_id ?? '';
}
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
async function requireActiveWallet(request, supabase, select = 'id, phone, is_active, kyc_level, token_version') {
    const payload = requireWalletAuth(request);
    if (!payload) {
        return {
            ok: false,
            status: 401,
            error: { error: 'Unauthorized', statusCode: 401 },
        };
    }
    const { data, error } = await supabase
        .from('wallet_users')
        .select(select)
        .eq('id', payload.wallet_id)
        .maybeSingle();
    if (error || !data) {
        return {
            ok: false,
            status: 404,
            error: { error: 'Wallet not found', statusCode: 404 },
        };
    }
    const row = data;
    // ── Token revocation check ──────────────────────────────────
    // Compare the token_version in the JWT with the current DB value.
    // Pre-migration tokens (without token_version claim) are treated as
    // version 0 by verifyWalletToken, so they pass when DB version is 0.
    const dbTokenVersion = row.token_version ?? 0;
    if (payload.token_version !== dbTokenVersion) {
        return {
            ok: false,
            status: 401,
            error: { error: 'TOKEN_REVOKED', statusCode: 401 },
        };
    }
    if (!row.is_active) {
        return {
            ok: false,
            status: 403,
            error: { error: 'Account is suspended', statusCode: 403 },
        };
    }
    return { ok: true, payload, wallet: row };
}
//# sourceMappingURL=wallet-auth.js.map