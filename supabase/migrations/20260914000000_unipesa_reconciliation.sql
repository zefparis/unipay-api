-- ============================================================
-- Migration: Unipesa reconciliation worker infrastructure
-- Version   : 20260914000000
-- ============================================================
-- Ports the reconciliation pattern from Congo Gaming
-- (20260529_unipesa_reconciliation_locks.sql) to the UniPay API
-- schema. Differences from the CG version:
--   * UniPay transactions.status is TEXT ('pending','processing',
--     'success','failed','cancelled'), not INTEGER.
--   * UniPay uses process_wallet_provider_callback() for atomic
--     credit/refund, so the worker reuses that RPC instead of
--     duplicating the balance logic.
--   * UniPay transactions have both wallet_user_id (wallet flow)
--     and merchant_id (merchant flow) — the callback RPC handles
--     both paths.
--
-- Concurrency hardening:
--   1. Worker-level lock (worker_locks table, TTL 2 min) so only
--      one reconciliation tick runs at a time across the fleet.
--   2. Row-level claim via claim_pending_unipay_transactions RPC,
--      which uses SELECT ... FOR UPDATE SKIP LOCKED + a stamp on
--      reconcile_attempted_at.
--   3. Idempotency: process_wallet_provider_callback inserts into
--      provider_webhook_events with a UNIQUE(provider, provider_event_id)
--      constraint, so a callback and a reconciliation tick racing on
--      the same transaction cannot produce a double credit/refund.

-- ── Worker lock table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.worker_locks (
  worker_name  TEXT PRIMARY KEY,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.worker_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_locks_service_role_all ON public.worker_locks;
CREATE POLICY worker_locks_service_role_all
  ON public.worker_locks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Worker lock acquire/release RPCs ─────────────────────────
-- pg_try_advisory_lock is session-scoped, but Supabase serves RPC
-- calls through a connection pool, so the lock would be released
-- the moment the acquire RPC returns. We use a bookkeeping table
-- with a TTL instead, giving the same semantics across instances
-- and surviving pool churn.

CREATE OR REPLACE FUNCTION public.try_acquire_worker_lock(
  p_worker_name TEXT,
  p_ttl_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_expires TIMESTAMPTZ := v_now + make_interval(secs => p_ttl_seconds);
BEGIN
  INSERT INTO public.worker_locks (worker_name, acquired_at, expires_at)
  VALUES (p_worker_name, v_now, v_expires)
  ON CONFLICT (worker_name) DO UPDATE
    SET acquired_at = excluded.acquired_at,
        expires_at  = excluded.expires_at
    WHERE public.worker_locks.expires_at < v_now;

  RETURN EXISTS (
    SELECT 1
    FROM public.worker_locks
    WHERE worker_name = p_worker_name
      AND acquired_at = v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_worker_lock(
  p_worker_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.worker_locks WHERE worker_name = p_worker_name;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_worker_lock(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_worker_lock(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_acquire_worker_lock(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_worker_lock(TEXT) TO service_role;

-- ── reconcile_attempted_at column on transactions ────────────
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reconcile_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS transactions_pending_reconcile_idx
  ON public.transactions (created_at)
  WHERE status = 'processing';

-- ── Claim pending transactions RPC ────────────────────────────
-- Atomically claim up to N processing transactions for
-- reconciliation. Uses SELECT ... FOR UPDATE SKIP LOCKED so two
-- concurrent calls never return the same row, then stamps
-- reconcile_attempted_at so a subsequent call within the cooldown
-- skips them. After the cooldown elapses, another worker can retry
-- (covers crashes after claim but before resolution).
--
-- UniPay status is TEXT ('processing'), not INTEGER (1) like CG.

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
    WHERE status = 'processing'
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
