import type { FastifyPluginAsync } from 'fastify';
export declare const SUPPORTED_TOKENS: readonly [{
    readonly symbol: "USDT";
    readonly contract: string;
    readonly decimals: 18;
    readonly name: "Tether USD";
}, {
    readonly symbol: "wCGLT";
    readonly contract: string;
    readonly decimals: 18;
    readonly name: "Wrapped CGLT";
}];
export declare function deriveDepositAddress(hdIndex: number): string;
declare const walletCryptoDepositRoute: FastifyPluginAsync;
export default walletCryptoDepositRoute;
