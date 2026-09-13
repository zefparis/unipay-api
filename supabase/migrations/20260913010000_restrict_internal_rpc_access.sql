-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260913010000_restrict_internal_rpc_access.sql
-- Purpose  : Revoke EXECUTE from anon and authenticated on 5 internal
--            SECURITY DEFINER functions that were still callable via the
--            REST API without authentication.
--
-- Root cause:
--   The migrations that created these functions included
--   `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, but in Supabase the `anon`
--   and `authenticated` roles have explicit grants via PostgREST that are
--   independent of the `PUBLIC` meta-role. `REVOKE FROM PUBLIC` does NOT
--   revoke from `anon` or `authenticated` — they retain EXECUTE and can
--   call the functions directly via /rest/v1/rpc/<name>.
--
-- Confirmed exploitable without auth (tested 2026-09-13):
--   - try_acquire_worker_lock      → 200 true (acquired a lock)
--   - release_worker_lock          → 204 (released a lock)
--   - mark_settlement_processing   → 400 SETTLEMENT_NOT_FOUND (executed)
--   - claim_pending_settlements    → 400 (executed, SQL bug)
--   - claim_pending_unipay_transactions → 200 [] (executed, returned rows)
--
-- All 5 functions are internal-only (called exclusively by the backend
-- service_role via supabase.rpc()). No frontend (unipay-congo, unipay-app)
-- calls any of them. Safe to restrict to service_role only.
--
-- This migration is idempotent — REVOKE is a no-op if the grant doesn't
-- exist.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. try_acquire_worker_lock ────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.try_acquire_worker_lock(
  TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.try_acquire_worker_lock(
  TEXT, INTEGER
) TO service_role;

-- ── 2. release_worker_lock ────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.release_worker_lock(
  TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_worker_lock(
  TEXT
) TO service_role;

-- ── 3. claim_pending_unipay_transactions ─────────────────────
REVOKE EXECUTE ON FUNCTION public.claim_pending_unipay_transactions(
  INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pending_unipay_transactions(
  INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;

-- ── 4. claim_pending_settlements ──────────────────────────────
REVOKE EXECUTE ON FUNCTION public.claim_pending_settlements(
  INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pending_settlements(
  INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;

-- ── 5. mark_settlement_processing ─────────────────────────────
REVOKE EXECUTE ON FUNCTION public.mark_settlement_processing(
  UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_settlement_processing(
  UUID, TEXT
) TO service_role;
