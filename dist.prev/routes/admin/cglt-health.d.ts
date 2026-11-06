/**
 * Admin endpoint: GET /v1/admin/blockchain/cglt-health
 *
 * Returns sanitized CGLT blockchain configuration status.
 * No secrets are exposed. Requires admin authentication.
 */
import type { FastifyPluginAsync } from 'fastify';
declare const cgltHealthRoute: FastifyPluginAsync;
export default cgltHealthRoute;
