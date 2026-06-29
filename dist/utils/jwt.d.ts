export interface JwtPayload {
    merchant_id: string;
    email: string;
    iat: number;
    exp: number;
}
export declare function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string, expiresInSeconds?: number): string;
export declare function verifyToken(token: string, secret: string): JwtPayload | null;
