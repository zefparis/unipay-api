/**
 * Admin routes — Quotes (devis)
 *
 * POST   /v1/admin/quotes               — créer un devis (multipart avec fichier optionnel)
 * GET    /v1/admin/quotes               — liste filtrable (status, creditor_id)
 * PATCH  /v1/admin/quotes/:id           — éditer (montant, statut, validité, notes)
 * POST   /v1/admin/quotes/:id/accept    — accepter → crée automatiquement une dev_expense
 * POST   /v1/admin/quotes/:id/reject    — rejeter
 *
 * Auth: x-admin-secret (request.isAdmin via HMAC plugin)
 * Storage: bucket dev-expenses-invoices, sous-dossier quotes/
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminQuotesRoute: FastifyPluginAsync;
export default adminQuotesRoute;
