-- ============================================================
-- Fix claim_pending_settlements: column ambiguity (42702)
-- ============================================================
-- The function created by 20260913000000_settlement_callback_fix.sql
-- throws `column reference "id" is ambiguous` on every call: the
-- RETURNS TABLE out-parameter `id` collides with the table column
-- `id` in the UPDATE/WHERE/RETURNING clauses. It has never succeeded
-- in production — every reconciliation tick fails with
-- 'settlement_claim_failed' and stuck settlements are never claimed.
--
-- Fix: qualify all column references with table aliases and add
-- reconciled settlement columns are unchanged (same signature).

CREATE OR REPLACE FUNCTION public.claim_pending_settlements(
  p_min_age_seconds INTEGER DEFAULT 300,
  p_max_age_seconds INTEGER DEFAULT 604800,
  p_batch_size INTEGER DEFAULT 50,
  p_retry_after_seconds INTEGER DEFAULT 300
) RETURNS TABLE (
  id uuid,
  merchant_id uuid,
  amount numeric,
  currency text,
  phone text,
  provider_ref text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.merchant_settlement_requests AS msr
  SET reconcile_attempted_at = now()
  WHERE msr.id IN (
    SELECT s.id
    FROM public.merchant_settlement_requests AS s
    WHERE s.status = 'processing'
      AND s.created_at <= now() - make_interval(secs => p_min_age_seconds)
      AND s.created_at >= now() - make_interval(secs => p_max_age_seconds)
      AND (
        s.reconcile_attempted_at IS NULL
        OR s.reconcile_attempted_at < now() - make_interval(secs => p_retry_after_seconds)
      )
    ORDER BY s.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    msr.id,
    msr.merchant_id,
    msr.amount,
    msr.currency,
    msr.phone,
    msr.provider_ref,
    msr.created_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_pending_settlements(
  INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pending_settlements(
  INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;
