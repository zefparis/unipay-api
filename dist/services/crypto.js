"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiatePayment = initiatePayment;
exports.checkStatus = checkStatus;
const env_1 = require("../config/env");
/**
 * USDT (Tether) service stub.
 * TODO: Replace with real on-chain / custodial USDT payment logic.
 * Config: env.USDT_WALLET_ADDRESS
 */
async function initiatePayment(payload) {
    void env_1.env.USDT_WALLET_ADDRESS;
    void payload.reference; // acknowledged — USDT does not use reference for on-chain routing
    const providerRef = `USDT-${Date.now()}-${payload.transaction_id.slice(0, 8)}`;
    return {
        provider_ref: providerRef,
        status: 'processing',
        raw: {
            stub: true,
            channel: 'usdt',
            wallet: env_1.env.USDT_WALLET_ADDRESS ?? 'NOT_SET',
            payload,
        },
    };
}
async function checkStatus(providerRef) {
    return {
        provider_ref: providerRef,
        status: 'processing',
        message: 'Stub: USDT on-chain confirmation not yet implemented',
    };
}
//# sourceMappingURL=crypto.js.map