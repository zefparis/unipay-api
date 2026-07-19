/**
 * Admin endpoint: GET /v1/admin/blockchain/cglt-health
 *
 * Returns sanitized CGLT blockchain configuration status.
 * No secrets are exposed. Requires admin authentication.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getCgltBlockchainMode, getWcgltDepositProcessor } from '../../config/cglt-blockchain-mode';
import { getLastCgltConfigValidation, validateCgltConfig } from '../../config/cglt-config-validator';

const cgltHealthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/admin/blockchain/cglt-health',
    async (request, reply) => {
      if (!request.isAdmin) {
        return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
      }

      // Re-run validation on demand (read-only checks)
      const validation = await validateCgltConfig(fastify.log);

      return {
        mode: getCgltBlockchainMode(),
        wcglt_deposit_processor: getWcgltDepositProcessor(),
        chain_id_expected: validation.chain_id_expected,
        chain_id_actual: validation.chain_id_actual,
        rpc_reachable: validation.rpc_reachable,
        cglt_contract_configured: validation.cglt_contract_configured,
        cglt_contract_has_code: validation.cglt_contract_has_code,
        wcglt_contract_configured: validation.wcglt_contract_configured,
        wcglt_contract_has_code: validation.wcglt_contract_has_code,
        bridge_reachable: validation.bridge_reachable,
        bridge_endpoint_compatible: validation.bridge_endpoint_compatible,
        configuration_valid: validation.configuration_valid,
        errors: validation.errors,
      };
    },
  );
};

export default cgltHealthRoute;
