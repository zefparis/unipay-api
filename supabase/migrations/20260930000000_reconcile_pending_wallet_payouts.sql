-- ══════════════════════════════════════════════════════════════
-- Reconcile wallet payouts left 'pending' by an ambiguous provider
-- outcome (timeout / network / 5xx / unknown result.code).
--
-- Context: 20260929000000 introduced wallet_withdraw_claim, which
-- inserts the payout row as 'pending' and debits the wallet in the
-- same transaction. When the subsequent /payment_b2c call has an
-- AMBIGUOUS outcome the route does NOT refund (the payout may exist
-- at Unipesa) and leaves the row 'pending'. Until now the
-- reconciliation worker only claimed status = 'processing', so such
-- rows were never looked at again — debited money with no automated
-- resolution.
--
-- This migration widens claim_pending_unipay_transactions so the
-- worker ALSO claims wallet payouts still 'pending' (same age window:
-- > p_min_age_seconds, < p_max_age_seconds). Nothing else changes:
-- the worker queries Unipesa /status by order_id = transactions.reference
-- (the exact value sent as order_id at initiation — see
-- services/avada.ts initiatePayout) and resolves through
-- process_wallet_provider_callback, which for a failed wallet payout
-- delegates to wallet_withdraw_fail_and_refund (single refund path).
--
-- Response handling (implemented in services/unipesa-reconciliation.ts):
--   status 2 (success)   → callback 'success' → tx success, no balance
--                          change (payout already debited at claim).
--   status 3 (failed)    → callback 'failed'  → atomic refund amount+fee,
--                          once (already_terminal guard on replays).
--   status 0/1           → still in flight, retry next tick.
--   status -1 (PARENT OPERATION NOT FOUND) → treated as 'failed' ONLY
--                          when the tx is older than the -1 grace period
--                          (15 min, RECONCILE_NOT_FOUND_GRACE_SECONDS);
--                          younger rows are logged and skipped.
--
-- Why the -1 grace period: a "not found" answer right after a timeout
-- is ambiguous. Unipesa may have accepted the order but not yet made
-- it visible to /status (late indexing / async persistence at the
-- provider). Refunding on a premature -1 would recreate the double
-- spend this whole chain is meant to prevent (wallet refunded + payout
-- later executed). After 15 minutes with no trace, the order is
-- considered never created and the refund is safe.
--
-- Not covered here: pending rows of other kinds (merchant payouts,
-- collects) keep the previous behaviour — only 'processing' is claimed.
-- ══════════════════════════════════════════════════════════════

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
        -- NEW: wallet payouts claimed by wallet_withdraw_claim whose
        -- provider call had an ambiguous outcome. They carry a
        -- reference (= Unipesa order_id) so /status can be queried
        -- even when avada_transaction_id IS NULL.
        OR (
          status = 'pending'
          AND direction = 'payout'
          AND wallet_user_id IS NOT NULL
          AND reference IS NOT NULL
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

-- CREATE OR REPLACE resets the ACL to EXECUTE → PUBLIC. Re-apply the
-- restriction from 20260913010000_restrict_internal_rpc_access.sql.
REVOKE ALL ON FUNCTION public.claim_pending_unipay_transactions(
  INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pending_unipay_transactions(
  INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;
