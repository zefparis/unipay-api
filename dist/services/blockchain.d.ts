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
export type SwapDirection = 'cglt_to_usdt' | 'usdt_to_cglt';
export interface SwapResult {
    amountIn: number;
    amountOut: number;
    fee: number;
    txHash: string;
}
export declare function mintWCGLTonBSC(bscAddress: string, amount: number): Promise<string>;
export declare function swapWCGLTtoUSDT(wcgltAmount: number, recipientAddress: string): Promise<{
    usdtReceived: number;
    txHash: string;
}>;
export declare function executeSwap(direction: SwapDirection, amount: number): Promise<SwapResult>;
