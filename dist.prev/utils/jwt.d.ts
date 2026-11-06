export interface JwtPayload {
    merchant_id: string;
    email: string;
    token_version: number;
    iat: number;
    exp: number;
}
export declare function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, expiresInSeconds?: number): string;
export declare function verifyToken(token: string, secret: string): JwtPayload | null;
