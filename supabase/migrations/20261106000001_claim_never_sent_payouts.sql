-- ============================================================
-- claim_pending_unipay_transactions — inclure les payouts jamais envoyés
-- ============================================================
-- Avec initiate_merchant_payout (même série de migrations), une tx
-- payout peut rester 'pending' avec un débit ledger si le process
-- meurt entre le RPC atomique et l'appel provider : jamais envoyée
-- à Unipesa, donc avada_transaction_id IS NULL. La version
-- précédente du claim ne prenait que status='processing' — ces
-- orphelins n'étaient jamais résolus (marchand débité à vie).
--
-- On élargit le prédicat, UNIQUEMENT pour ce cas précis :
--   status='pending' AND direction='payout'
--   AND avada_transaction_id IS NULL AND merchant_id IS NOT NULL
-- Le MIN_AGE (90 s) écarte les requêtes encore en vol.
-- Les 'pending' collect/p2p/wallet restent hors scope (ils n'ont pas
-- de débit ledger à compenser et certains attendent légitimement).
CREATE OR REPLACE FUNCTION public.claim_pending_unipay_transactions(
  p_min_age_seconds    INTEGER DEFAULT 90,
  p_max_age_seconds    INTEGER DEFAULT 604800,
  p_batch_size         INTEGER DEFAULT 50,
  p_retry_after_seconds INTEGER DEFAULT 90
)
RETURNS SETOF public.transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.transactions
    WHERE (
        status = 'processing'
        OR (
          status = 'pending'
          AND direction = 'payout'
          AND avada_transaction_id IS NULL
          AND merchant_id IS NOT NULL
        )
      )
      AND created_at <= now() - make_interval(secs => p_min_age_seconds)
      AND created_at >= now() - make_interval(secs => p_max_age_seconds)
      AND (
        reconcile_attempted_at IS NULL
        OR reconcile_attempted_at < now() - make_interval(secs => p_retry_after_seconds)
      )
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.transactions t
    SET reconcile_attempted_at = now()
    FROM candidates c
    WHERE t.id = c.id
    RETURNING t.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_pending_unipay_transactions(INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_unipay_transactions(INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;

-- Index partiel pour la nouvelle classe de candidats (volume faible)
CREATE INDEX IF NOT EXISTS transactions_pending_payout_never_sent_idx
  ON public.transactions (created_at)
  WHERE status = 'pending'
    AND direction = 'payout'
    AND avada_transaction_id IS NULL;
