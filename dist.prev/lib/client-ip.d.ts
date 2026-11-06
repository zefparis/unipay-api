import type { FastifyRequest } from 'fastify';
export declare function isTrustedProxy(addr: string | undefined): boolean;
/** Prédicat Fastify trustProxy : seuls les sauts privés sont de confiance. */
export declare function trustedProxy(addr: string, _hopIndex: number): boolean;
/**
 * Vérifie l'en-tête signé du BFF : x-unipay-client-ip +
 * x-unipay-client-sig = HMAC-SHA256(ip, BFF_IP_SECRET).
 * Sans secret configuré ou signature invalide → null (jamais utilisé).
 * Un client direct ne peut pas le forger sans le secret.
 */
export declare function verifySignedClientIp(req: FastifyRequest): string | null;
/**
 * Clé de compteur rate-limit : IP signée du BFF si valide (chaque
 * marchand via Vercel a son propre compteur), sinon req.ip corrigée.
 */
export declare function rateLimitKey(req: FastifyRequest): string;
/**
 * Clé par clé API (payment/initiate) : le quota suit la clé, pas l'IP.
 * Un marchand ne partage son compteur qu'avec ses propres clés ; sans
 * clé, repli sur l'IP.
 */
export declare function apiKeyLimitKey(req: FastifyRequest): string;
