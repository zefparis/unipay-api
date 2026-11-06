/**
 * Admin routes — Dev Expenses Tracker (v2: generalised creditor/invoice registry)
 *
 * POST   /v1/admin/dev-expenses/pull-automated   — pull Anthropic + Vercel costs (cron)
 * POST   /v1/admin/dev-expenses                  — manual invoice entry with upload
 * PATCH  /v1/admin/dev-expenses/:id/mark-paid    — mark expense as paid
 * POST   /v1/admin/dev-expenses/generate-report  — generate PDF + share token
 * GET    /v1/admin/dev-expenses                  — list (billing_month/status/creditor_id/overdue)
 * GET    /v1/admin/dev-expenses/upcoming         — due within 7 days, status=pending
 * GET    /v1/admin/dev-expenses/history          — paginated monthly history
 *
 * PUBLIC (no admin auth, token-protected):
 * GET    /dev-expenses/report/:token             — read-only report JSON
 *
 * Auth: request.isAdmin (x-admin-secret via HMAC plugin)
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminDevExpensesRoute: FastifyPluginAsync;
export default adminDevExpensesRoute;
