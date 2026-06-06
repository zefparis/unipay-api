export const KYC_LIMITS = {
  0: { deposit_daily: 5_000,   withdraw_daily: 5_000,   p2p_single: 2_000 },
  1: { deposit_daily: 500_000, withdraw_daily: 200_000, p2p_single: 100_000 },
} as const;

export type KycLevel = keyof typeof KYC_LIMITS;

export function getLimits(kyc_level: number) {
  return KYC_LIMITS[(kyc_level as KycLevel) in KYC_LIMITS ? (kyc_level as KycLevel) : 0];
}
