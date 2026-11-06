"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WALLET_FEE_RATE = void 0;
exports.walletFee = walletFee;
const env_1 = require("../config/env");
/**
 * Wallet (grand public) fee rate — deposit and withdraw.
 * Single source of truth: env WALLET_FEE_RATE, default 0.05 = 5%.
 * The Avada/Unipesa provider cost (3%) is internal-only and must
 * never appear in user-facing output.
 */
exports.WALLET_FEE_RATE = Number(env_1.env.WALLET_FEE_RATE);
function walletFee(amount) {
    return Math.round(amount * exports.WALLET_FEE_RATE * 100) / 100;
}
//# sourceMappingURL=wallet-fees.js.map