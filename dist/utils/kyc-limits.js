"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KYC_LIMITS = void 0;
exports.getLimits = getLimits;
exports.KYC_LIMITS = {
    0: { deposit_daily: 5_000, withdraw_daily: 5_000, p2p_single: 2_000 },
    1: { deposit_daily: 500_000, withdraw_daily: 200_000, p2p_single: 100_000 },
};
function getLimits(kyc_level) {
    return exports.KYC_LIMITS[kyc_level in exports.KYC_LIMITS ? kyc_level : 0];
}
//# sourceMappingURL=kyc-limits.js.map