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
    .select('status, token_version')
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

  return { ok: true, payload };
}

/**
 * Dual-auth for /v1/merchant/* endpoints that must accept BOTH the
 * dashboard JWT session AND the merchant API key (X-API-Key).
 *
 * The hmac plugin deliberately skips /v1/merchant/* paths, so API-key
 * verification is replicated here: prefix lookup (first 12 chars of
 * the key) then bcrypt compare over every candidate — same algorithm
 * as plugins/hmac.ts.
 *
 * Tries JWT first, then falls back to X-API-Key.
 */
export async function requireMerchantIdentity(
  request: { headers: Record<string, string | string[] | undefined> },
  supabase: SupabaseClient,
): Promise<
  | { ok: true; merchantId: string; via: 'jwt' | 'api_key' }
  | { ok: false; status: 401 | 403 | 404; error: { error: string; statusCode: number } }
> {
  // ── 1. JWT path (dashboard session) ──────────────────────────
  const auth = await requireActiveMerchant(request, supabase);
  if (auth.ok) {
    return { ok: true, merchantId: auth.payload.merchant_id, via: 'jwt' };
  }
  // A JWT was presented but rejected (revoked/suspended/not found) —
  // do NOT silently fall back to the API key.
  if (auth.status !== 401) {
    return { ok: false, status: auth.status, error: auth.error };
  }

  // ── 2. API-key path (X-API-Key) ──────────────────────────────
  const apiKey = request.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return { ok: false, status: 401, error: { error: 'Unauthorized', statusCode: 401 } };
  }

  const prefix = apiKey.substring(0, 12);
  const { data: keys, error } = await supabase
    .from('api_keys')
    .select('*, merchants!inner(id, status, deleted_at)')
    .eq('key_prefix', prefix)
    .eq('is_active', true);

  if (error || !keys || keys.length === 0) {
    return { ok: false, status: 401, error: { error: 'Unauthorized', statusCode: 401 } };
  }

  for (const k of keys as { key_hash: string; merchants: { id: string; status: string; deleted_at: string | null } }[]) {
    if (await bcrypt.compare(apiKey, k.key_hash)) {
      if (k.merchants.status !== 'active' || k.merchants.deleted_at !== null) {
        return { ok: false, status: 403, error: { error: 'Compte suspendu', statusCode: 403 } };
      }
      return { ok: true, merchantId: k.merchants.id, via: 'api_key' };
    }
  }

  return { ok: false, status: 401, error: { error: 'Unauthorized', statusCode: 401 } };
}
