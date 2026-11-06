/**
 * Admin routes — Creditors registry
 *
 * POST   /v1/admin/creditors       — create creditor
 * GET    /v1/admin/creditors       — list (filterable: active, entity_type)
 * PATCH  /v1/admin/creditors/:id   — update (name, email, payment details, etc.)
 * DELETE /v1/admin/creditors/:id   — soft-delete (active=false; never real delete)
 *
 * Auth: x-admin-secret (request.isAdmin set by HMAC plugin)
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminCreditorsRoute: FastifyPluginAsync;
export default adminCreditorsRoute;
