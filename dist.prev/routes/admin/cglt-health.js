"use strict";
/**
 * Admin endpoint: GET /v1/admin/blockchain/cglt-health
 *
 * Returns sanitized CGLT blockchain configuration status.
 * No secrets are exposed. Requires admin authentication.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const cglt_blockchain_mode_1 = require("../../config/cglt-blockchain-mode");
const cglt_config_validator_1 = require("../../config/cglt-config-validator");
const cgltHealthRoute = async (fastify) => {
    fastify.get('/admin/blockchain/cglt-health', async (request, reply) => {
        if (!request.isAdmin) {
            return reply.status(403).send({ error: 'Admin access required', statusCode: 403 });
        }
        // Re-run validation on demand (read-only checks)
        const validation = await (0, cglt_config_validator_1.validateCgltConfig)(fastify.log);
        return {
            mode: (0, cglt_blockchain_mode_1.getCgltBlockchainMode)(),
            wcglt_deposit_processor: (0, cglt_blockchain_mode_1.getWcgltDepositProcessor)(),
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
    });
};
exports.default = cgltHealthRoute;
//# sourceMappingURL=cglt-health.js.map