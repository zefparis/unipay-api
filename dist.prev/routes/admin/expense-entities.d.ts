/**
 * Admin routes — Expense Entities (V4)
 *
 * GET    /v1/admin/expense-entities       — list (filterable: active, entity_type)
 * POST   /v1/admin/expense-entities       — create entity
 * PATCH  /v1/admin/expense-entities/:id   — update entity
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 * No DELETE: entities referenced by financial data cannot be physically deleted.
 * Soft-delete via active=false is supported through PATCH.
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminExpenseEntitiesRoute: FastifyPluginAsync;
export default adminExpenseEntitiesRoute;
