/**
 * Admin routes — Dev Expenses V4
 *
 * GET    /v1/admin/dev-expenses-v4                       — paginated list with filters
 * POST   /v1/admin/dev-expenses-v4                       — create expense
 * GET    /v1/admin/dev-expenses-v4/:id                   — detail with settlements, audit, entities
 * PATCH  /v1/admin/dev-expenses-v4/:id                   — update expense
 * POST   /v1/admin/dev-expenses-v4/:id/transition         — state machine transition
 * GET    /v1/admin/dev-expenses-v4/:id/settlements        — list settlements
 * POST   /v1/admin/dev-expenses-v4/:id/settlements        — create settlement
 * PATCH  /v1/admin/dev-expenses-v4/:id/settlements/:sid   — update settlement
 * GET    /v1/admin/dev-expenses-v4/:id/audit              — audit trail
 * GET    /v1/admin/dev-expenses-v4/stats                  — statistics grouped by currency
 * POST   /v1/admin/dev-expenses-v4/:id/resolve-migration-review — resolve migration review
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminDevExpensesV4Route: FastifyPluginAsync;
export default adminDevExpensesV4Route;
