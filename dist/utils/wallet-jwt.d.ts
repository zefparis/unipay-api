export interface WalletJwtPayload {
    wallet_id: string;
    phone: string;
    role: 'wallet';
    iat: number;
    exp: number;
}
export declare function signWalletToken(payload: Omit<WalletJwtPayload, 'iat' | 'exp'>, secret: string, expiresInSeconds?: number): string;
export declare function verifyWalletToken(token: string, secret: string): WalletJwtPayload | null;
export declare function requireWallet(auth: string | undefined, secret: string): WalletJwtPayload | null;
export interface RefreshTokenPayload {
    wallet_id: string;
    role: 'wallet_refresh';
    iat: number;
    exp: number;
}
export declare function signRefreshToken(payload: {
    wallet_id: string;
}, secret: string, expiresInSeconds?: number): string;
export declare function verifyRefreshToken(token: string, secret: string): RefreshTokenPayload | null;
