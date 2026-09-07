import type { SupabaseClient } from '@supabase/supabase-js';
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
  | { ok: false; status: number; error: { error: string; statusCode: number } }
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
    .select('status')
    .eq('id', payload.merchant_id)
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 404,
      error: { error: 'Merchant not found', statusCode: 404 },
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
