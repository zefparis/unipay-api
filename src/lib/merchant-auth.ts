import type { SupabaseClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { verifyToken, type JwtPayload } from '../utils/jwt.js';
import { env } from '../config/env.js';

/**
 * Extract and verify the JWT from the Authorization header.
 * Returns the payload (containing merchant_id) or null.
 */
export function requireMerchantAuth(
  request: { headers: Record<string, string | string[] | undefined> },
): JwtPayload | null {
  if (!env.JWT_SECRET) return null;
  const auth = request.headers.authorization;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7), env.JWT_SECRET);
}

/**
 * Extract merchant_id from JWT (for use in rate-limit keyGenerator
 * where we only need the ID, not a full DB lookup).
 */
export function merchantIdFromRequest(
  request: { headers: Record<string, string | string[] | undefined> },
): string | null {
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
export async function requireMerchantSession(
  request: { headers: Record<string, string | string[] | undefined> },
  supabase: SupabaseClient,
): Promise<
  | { ok: true; payload: JwtPayload }
  | { ok: false; status: 401 | 404; error: { error: string; statusCode: number } }
> {
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

  const dbTokenVersion = (data as { token_version?: number }).token_version ?? 0;
  if (payload.token_version !== dbTokenVersion) {
    return { ok: false, status: 401, error: { error: 'TOKEN_REVOKED', statusCode: 401 } };
  }

  return { ok: true, payload };
}

/**
 * Identité marchand double canal : JWT de session dashboard OU X-API-Key.
 * Utilisée par les routes lisibles des deux façons (ex. programme partenaire).
 * - JWT  : requireActiveMerchant (session + statut 'active' requis)
 * - clé  : prefix lookup + bcrypt, merchants.status = 'active' requis
 */
export async function requireMerchantIdentity(
  request: { headers: Record<string, string | string[] | undefined> },
  supabase: SupabaseClient,
): Promise<
  | { ok: true; merchantId: string }
  | { ok: false; status: 401 | 403 | 404 | 500; error: { error: string; statusCode: number } }
> {
  const unauthorized = { ok: false as const, status: 401 as const, error: { error: 'Unauthorized', statusCode: 401 } };

  // ── Canal 1 : JWT de session (gate statut 'active' comme le reste de l'API)
  const hasJwt = typeof request.headers.authorization === 'string'
    && request.headers.authorization.startsWith('Bearer ');
  if (hasJwt) {
    const auth = await requireActiveMerchant(request, supabase);
    return auth.ok ? { ok: true, merchantId: auth.payload.merchant_id } : auth;
  }

  // ── Canal 2 : X-API-Key ────────────────────────────────────
  const apiKey = request.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') return unauthorized;

  const prefix = apiKey.substring(0, 12);
  const { data: keys, error } = await supabase
    .from('api_keys')
    .select('id, key_hash, merchant_id, merchants!inner(status)')
    .eq('key_prefix', prefix)
    .eq('is_active', true);
  if (error) return { ok: false, status: 500, error: { error: 'Internal Server Error', statusCode: 500 } };

  for (const k of (keys ?? []) as unknown as { key_hash: string; merchant_id: string; merchants: { status: string }[] }[]) {
    if (await bcrypt.compare(apiKey, k.key_hash)) {
      const status = k.merchants[0]?.status;
      if (status !== 'active') {
        return { ok: false, status: 403, error: { error: 'Compte suspendu', statusCode: 403 } };
      }
      return { ok: true, merchantId: k.merchant_id };
    }
  }
  return unauthorized;
}

export async function requireActiveMerchant(
  request: { headers: Record<string, string | string[] | undefined> },
  supabase: SupabaseClient,
): Promise<
  | { ok: true; payload: JwtPayload }
  | { ok: false; status: 401 | 403 | 404; error: { error: string; statusCode: number } }
> {
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
  const dbTokenVersion = (data as { token_version?: number }).token_version ?? 0;
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
  const accessStatus = (data as { access_status?: string }).access_status ?? 'active';
  if (accessStatus !== 'active') {
    return {
      ok: false,
      status: 403,
      error: {
        error: 'Vérification de votre dossier requise — envoyez vos documents KYC depuis votre espace marchand.',
        code: 'KYC_REQUIRED',
        statusCode: 403,
      } as { error: string; statusCode: number },
    };
  }

  return { ok: true, payload };
}
