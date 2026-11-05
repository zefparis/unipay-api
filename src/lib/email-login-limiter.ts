/**
 * Limiteur de tentatives de login par IDENTIFIANT (email), glissant
 * sur fenêtre en mémoire. Contexte RDC : les réseaux mobiles sont
 * massivement en CGNAT — des milliers de clients partagent la même
 * IP publique, une limite par IP stricte bloquerait des innocents.
 * La limite par email (5/min) bloque le credential stuffing ciblé
 * sans pénaliser les voisins de NAT ; la limite large par IP (60/min)
 * couvre le bourrage distribué.
 *
 * In-memory comme @fastify/rate-limit (per-process) — suffisant
 * pour le déploiement mono-instance actuel.
 */
const buckets = new Map<string, number[]>();

const PRUNE_AFTER_MS = 60 * 60 * 1000;

export function loginEmailAllowed(email: string, max = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

/** Test-only : purge périodique des entrées anciennes. */
export function pruneEmailBuckets(now = Date.now()): void {
  for (const [k, arr] of buckets) {
    const keep = arr.filter((t) => now - t < PRUNE_AFTER_MS);
    if (keep.length === 0) buckets.delete(k); else buckets.set(k, keep);
  }
}

/** Test-only : réinitialiser les compteurs. */
export function resetEmailLimiter(): void {
  buckets.clear();
}
