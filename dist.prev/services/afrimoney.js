"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiatePayment = initiatePayment;
exports.checkStatus = checkStatus;
const avada = __importStar(require("./avada"));
const OPERATOR = 'Afrimoney';
async function initiatePayment(payload) {
    const { avada_transaction_id } = payload.direction === 'collect'
        ? await avada.initiateCollection(OPERATOR, payload.phone, payload.amount, payload.reference, payload.currency)
        : await avada.initiatePayout(OPERATOR, payload.phone, payload.amount, payload.reference, payload.currency);
    return {
        provider_ref: avada_transaction_id,
        status: 'processing',
        raw: { operator: OPERATOR, avada_transaction_id },
    };
}
async function checkStatus(providerRef) {
    const avadaStatus = await avada.getTransactionStatus(providerRef);
    const status = avadaStatus === 'success' ? 'success'
        : avadaStatus === 'failed' || avadaStatus === 'cancelled' ? 'failed'
            : 'processing';
    return { provider_ref: providerRef, status };
}
//# sourceMappingURL=afrimoney.js.map