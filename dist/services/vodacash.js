"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiatePayment = initiatePayment;
exports.checkStatus = checkStatus;
/**
 * Vodacash / M-Pesa (Vodacom DRC) — direct integration, NOT via Avada.
 * CGL is currently in due diligence with Vodacom DRC.
 * This service is intentionally unreachable: initiate.ts guards against
 * vodacash requests and returns 503 before calling this service.
 */
async function initiatePayment(_payload) {
    throw new Error('Vodacash integration not yet available — CGL in due diligence with Vodacom DRC');
}
async function checkStatus(providerRef) {
    return {
        provider_ref: providerRef,
        status: 'pending',
        message: 'Vodacash integration not yet available',
    };
}
//# sourceMappingURL=vodacash.js.map