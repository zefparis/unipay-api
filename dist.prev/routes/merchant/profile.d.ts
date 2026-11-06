import type { FastifyPluginAsync } from 'fastify';
/**
 * Merchant profile routes — self-service account management.
 *
 *   GET   /merchant/profile              — read own profile
 *   PATCH /merchant/profile              — update name, phone, company_name
 *   POST  /merchant/profile/change-email — change login email (requires current_password)
 *   POST  /merchant/profile/change-password — change password (requires current_password)
 *
 * Security:
 *   - All routes use requireActiveMerchant() → JWT-based, merchant_id from token only
 *   - No merchant_id in request bodies (isolation enforced by JWT)
 *   - change-email and change-password require current_password verification
 *   - Rate limited: 5 attempts/hour per merchant_id
 */
declare const profileRoute: FastifyPluginAsync;
export default profileRoute;
