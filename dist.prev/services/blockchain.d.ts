export declare function encryptPrivateKey(privateKey: string): string;
export declare function mintCGLT(walletAddress: string, amountCDF: number, txRef: string): Promise<string>;
export declare function burnCGLT(walletAddress: string, amountCDF: number, txRef: string): Promise<string>;
export declare function getCGLTBalance(walletAddress: string): Promise<number>;
export declare function generateWallet(): {
    address: string;
    privateKey: string;
};
export interface SwapRate {
    rate: number;
    fee: number;
    paused: boolean;
    /** Reserve (AMM pool) balances held by the reserve contract. */
    pool_usdt: number;
    pool_cglt: number;
}
export declare function getSwapRate(): Promise<SwapRate>;
