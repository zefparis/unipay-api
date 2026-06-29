import type { FastifyPluginAsync } from 'fastify';
export declare const SUPPORTED_TOKENS: readonly [{
    readonly symbol: "USDT";
    readonly contract: "0x55d398326f99059fF775485246999027B3197955";
    readonly decimals: 18;
    readonly name: "Tether USD";
}, {
    readonly symbol: "wCGLT";
    readonly contract: "0xfE4Ce029A1CB84Aa0D3906C7eC409f1496d13A3B";
    readonly decimals: 18;
    readonly name: "Wrapped CGLT";
}];
export declare function deriveDepositAddress(hdIndex: number): string;
declare const walletCryptoDepositRoute: FastifyPluginAsync;
export default walletCryptoDepositRoute;
