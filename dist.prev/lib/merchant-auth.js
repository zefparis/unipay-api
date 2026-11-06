"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireMerchantAuth = requireMerchantAuth;
exports.merchantIdFromRequest = merchantIdFromRequest;
exports.requireMerchantSession = requireMerchantSession;
exports.requireActiveMerchant = requireActiveMerchant;
const jwt_js_1 = require("../utils/jwt.js");
const env_js_1 = require("../config/env.js");
/**
 * Extract and verify the JWT from the Authorization header.
 * Returns the payload (containing merchant_id) or null.
 */
function requireMerchantAuth(request) {
    if (!env_js_1.env.JWT_SECRET)
        return null;
    const auth = request.headers.authorization;
    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer '))
        return null;
    return (0, jwt_js_1.verifyToken)(auth.slice(7), env_js_1.env.JWT_SECRET);
}
/**
 * Extract merchant_id from JWT (for use in rate-limit keyGenerator
 * where we only need the ID, not a full DB lookup).
 */
function merchantIdFromRequest(request) {
    const payload = requireMerchantAuth(request);
    return payload?.merchant_id ?? null;
}
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
async function requireMerchantSession(request, supabase) {
    const payload = requireMerchantAuth(request);
    if (!payload) {
        return { ok: false, status: 401, error: { error: 'Unauthorized', statusCode: 401 } };
    }
    const { data, error } = await supabase
        .from('merchants')
        .select('status, access_status, token_version')
        .eq('id', payload.merchant_id)
        .maybeSingle();
    if (error || !data) {
        return { ok: false, status: 404, error: { error: 'Merchant not found', statusCode: 404 } };
    }
    const dbTokenVersion = data.token_version ?? 0;
    if (payload.token_version !== dbTokenVersion) {
        return { ok: false, status: 401, error: { error: 'TOKEN_REVOKED', statusCode: 401 } };
    }
    return { ok: true, payload };
}
async function requireActiveMerchant(request, supabase) {
    const payload = requireMerchantAuth(request);
    if (!payload) {
        return {
            ok: false,
            status: 401,
            error: { error: 'Unauthorized', statusCode: 401 },
        };
    }
    const { data, error } = await supabase
        .from('merchants')
        .select('status, access_status, token_version')
        .eq('id', payload.merchant_id)
        .maybeSingle();
    if (error || !data) {
        return {
            ok: false,
            status: 404,
            error: { error: 'Merchant not found', statusCode: 404 },
        };
    }
    // ── Token revocation check ──────────────────────────────────
    // Compare the token_version in the JWT with the current DB value.
    // Pre-migration tokens (without token_version claim) are treated as
    // version 0 by verifyToken, so they pass when DB version is still 0.
    const dbTokenVersion = data.token_version ?? 0;
    if (payload.token_version !== dbTokenVersion) {
        return {
            ok: false,
            status: 401,
            error: { error: 'TOKEN_REVOKED', statusCode: 401 },
        };
    }
    if (data.status !== 'active') {
        return {
            ok: false,
            status: 403,
            error: { error: 'Compte suspendu', statusCode: 403 },
        };
    }
    // Conformité KYC : pas d'accès tant que le dossier n'est pas validé
    // (kyc_required = en attente de validation, suspended_kyc = incomplet).
    const accessStatus = data.access_status ?? 'active';
    if (accessStatus !== 'active') {
        return {
            ok: false,
            status: 403,
            error: {
                error: 'Vérification de votre dossier requise — envoyez vos documents KYC depuis votre espace marchand.',
                code: 'KYC_REQUIRED',
                statusCode: 403,
            },
        };
    }
    return { ok: true, payload };
}
//# sourceMappingURL=merchant-auth.js.map