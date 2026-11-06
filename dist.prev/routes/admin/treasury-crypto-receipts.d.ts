/**
 * Admin routes — Treasury crypto invoice receipts (v2).
 *
 * Supports the full pending-invoice lifecycle:
 *   pending → received → confirmed
 *   pending / received → rejected | cancelled
 *   rejected → cancelled
 *
 * POST   /v1/admin/treasury/crypto-receipts                  — create pending receipt
 * GET    /v1/admin/treasury/crypto-receipts                  — list (filterable, ?include_archived)
 * GET    /v1/admin/treasury/crypto-receipts/:id             — get single + audit log
 * PATCH  /v1/admin/treasury/crypto-receipts/:id             — update receipt
 * POST   /v1/admin/treasury/crypto-receipts/:id/cancel      — cancel receipt
 * POST   /v1/admin/treasury/crypto-receipts/:id/archive     — archive receipt (hide from default view)
 * POST   /v1/admin/treasury/crypto-receipts/:id/restore     — restore archived receipt
 * DELETE /v1/admin/treasury/crypto-receipts/:id             — hard delete (safe drafts/tests only)
 * POST   /v1/admin/treasury/crypto-receipts/:id/verify      — optional BSC tx check
 *
 * Auth: x-admin-secret header (hmac plugin → request.isAdmin).
 *
 * IMPORTANT:
 *   Does NOT credit wallet_users.
 *   Does NOT trigger swaps, withdrawals, or bridge calls.
 *   Does NOT store or broadcast private keys.
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminTreasuryCryptoReceiptsRoute: FastifyPluginAsync;
export default adminTreasuryCryptoReceiptsRoute;
