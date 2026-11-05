import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

/**
 * Chaîne réelle des requêtes :
 *
 *   a) Appels directs marchands :
 *      client → Cloudflare (ajoute l'IP réelle en queue de X-Forwarded-For,
 *      écrase CF-Connecting-IP) → cloudflared (même hôte) → API
 *
 *   b) Via le portail (BFF) :
 *      navigateur → Vercel BFF → Cloudflare → cloudflared → API
 *      (l'IP vue en queue de XFF est l'IP de sortie Vercel, pas celle du
 *      client — d'où l'en-tête signé ci-dessous)
 *
 *   c) LAN / accès direct sur le port 3100 (x2, crons, health checks).
 *
 * trustProxy:true faisait confiance à TOUTE la chaîne XFF : un client
 * pouvait forger X-Forwarded-For et obtenir un compteur rate-limit vierge.
 * À la place, on ne fait confiance qu'aux sauts locaux/privés : le socket
 * cloudflared (127.0.0.1) et les réseaux privés (docker/LAN). Le premier
 * saut non privé en partant de la droite est l'IP ajoutée par Cloudflare
 * — l'IP réelle, non forgeable par le client (CF l'ajoute en queue).
 * Une entrée forgée plus à gauche est simplement ignorée.
 */
const PRIVATE_HOP = [
  /^127\./,                       // loopback v4
  /^10\./,                        // LAN
  /^192\.168\./,                  // LAN
  /^169\.254\./,                  // link-local
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // docker/LAN
  /^::1$/,                        // loopback v6
  /^f[cd]/i,                      // ULA v6
  /^fe80/i,                       // link-local v6
];

export function isTrustedProxy(addr: string | undefined): boolean {
  return !!addr && PRIVATE_HOP.some((re) => re.test(addr));
}

/** Prédicat Fastify trustProxy : seuls les sauts privés sont de confiance. */
export function trustedProxy(addr: string, _hopIndex: number): boolean {
  return isTrustedProxy(addr);
}

/**
 * Vérifie l'en-tête signé du BFF : x-unipay-client-ip +
 * x-unipay-client-sig = HMAC-SHA256(ip, BFF_IP_SECRET).
 * Sans secret configuré ou signature invalide → null (jamais utilisé).
 * Un client direct ne peut pas le forger sans le secret.
 */
export function verifySignedClientIp(req: FastifyRequest): string | null {
  const ip  = req.headers['x-unipay-client-ip'];
  const sig = req.headers['x-unipay-client-sig'];
  const secret = env.BFF_IP_SECRET;
  if (typeof ip !== 'string' || typeof sig !== 'string' || !secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(ip).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return ip;
}

/**
 * Clé de compteur rate-limit : IP signée du BFF si valide (chaque
 * marchand via Vercel a son propre compteur), sinon req.ip corrigée.
 */
export function rateLimitKey(req: FastifyRequest): string {
  return verifySignedClientIp(req) ?? req.ip;
}

/**
 * Clé par clé API (payment/initiate) : le quota suit la clé, pas l'IP.
 * Un marchand ne partage son compteur qu'avec ses propres clés ; sans
 * clé, repli sur l'IP.
 */
export function apiKeyLimitKey(req: FastifyRequest): string {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key.length > 8) {
    return `ak:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
  }
  return rateLimitKey(req);
}
