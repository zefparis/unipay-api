import type { AvadaStatus } from '../services/avada';

/**
 * Revérification du statut auprès d'Unipesa avant tout crédit déclenché
 * par un callback `success`. Décision en 3 cas, jamais plus :
 *
 *   credit   — provider confirme 'success'            → créditer
 *   reject   — provider dit failed / cancelled / rejected → 400 + warn
 *   defer    — tout le reste (pending, processing, statut inconnu,
 *              erreur réseau, timeout)                 → 503, tx laissée
 *              pending ; unipesa-reconciliation la reprend (tick 60 s,
 *              âge min 90 s).
 */
export type RecheckDecision =
  | { action: 'credit' }
  | { action: 'reject'; providerStatus: string }
  | { action: 'defer'; reason: string };

export const RECHECK_TIMEOUT_MS = 5000;

const REJECT_STATUSES = new Set(['failed', 'cancelled', 'rejected']);

export function decideFromStatus(status: string | undefined | null): RecheckDecision {
  if (status === 'success') return { action: 'credit' };
  if (status && REJECT_STATUSES.has(status)) return { action: 'reject', providerStatus: status };
  return { action: 'defer', reason: `provider status '${status ?? 'unknown'}' not terminal` };
}

/**
 * Appelle `getStatus` avec un timeout (clearTimeout si réponse avant).
 * Toute exception → defer.
 */
export async function recheckProviderStatus(
  getStatus: () => Promise<{ status: AvadaStatus | string }>,
  timeoutMs = RECHECK_TIMEOUT_MS,
): Promise<RecheckDecision> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      getStatus(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('status check timeout')), timeoutMs);
      }),
    ]);
    return decideFromStatus(result.status);
  } catch (e) {
    return { action: 'defer', reason: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
