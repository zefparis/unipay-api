export declare const KYC_LIMITS: {
    readonly 0: {
        readonly deposit_daily: 5000;
        readonly withdraw_daily: 5000;
        readonly p2p_single: 2000;
    };
    readonly 1: {
        readonly deposit_daily: 500000;
        readonly withdraw_daily: 200000;
        readonly p2p_single: 100000;
    };
};
export type KycLevel = keyof typeof KYC_LIMITS;
export declare function getLimits(kyc_level: number): {
    readonly deposit_daily: 5000;
    readonly withdraw_daily: 5000;
    readonly p2p_single: 2000;
} | {
    readonly deposit_daily: 500000;
    readonly withdraw_daily: 200000;
    readonly p2p_single: 100000;
};
