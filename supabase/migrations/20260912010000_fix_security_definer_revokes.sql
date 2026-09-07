-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260912010000_fix_security_definer_revokes.sql
-- Purpose  : Revoke EXECUTE from PUBLIC on all SECURITY DEFINER functions
--            that were missing REVOKE in their original migration, or that
--            were re-exposed by CREATE OR REPLACE FUNCTION in a later
--            migration without re-applying REVOKE.
--
-- Root cause:
--   1. Several migrations created SECURITY DEFINER functions WITHOUT
--      REVOKE ALL ON FUNCTION ... FROM PUBLIC. PostgreSQL grants EXECUTE
--      to PUBLIC by default, which includes the anon and authenticated
--      Supabase roles — allowing direct API REST calls that bypass the
--      backend entirely.
--
--   2. Some migrations DID have REVOKE, but a later migration used
--      CREATE OR REPLACE FUNCTION on the same function without re-applying
--      REVOKE. CREATE OR REPLACE resets the function's ACL to default
--      (EXECUTE to PUBLIC), silently re-exposing the function.
--
-- This migration applies REVOKE to ALL affected functions, using the
-- LATEST signature (the one currently in the database after all prior
-- migrations). The REVOKE is idempotent — it can be run safely even if
-- the grants were already revoked manually.
--
-- After this migration, the guard test in
--   supabase/tests/20260912000000_security_definer_grants_guard.sql
-- should PASS when run against the live database.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Functions from 20260610180000_swap_balances.sql (no REVOKE in original) ──
REVOKE ALL ON FUNCTION public.swap_balances(
  UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC
) FROM PUBLIC;

-- ── Functions from 20260718220000_dev_expenses_v4_transactional_rpc.sql ──
-- (no REVOKE in original — these are dev_expenses functions, not financial
--  wallet functions, but transition_expense and resolve_migration_review_with_audit
--  match the resolve_ whitelist prefix)
REVOKE ALL ON FUNCTION public.transition_expense(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.confirm_settlement(
  UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_settlement_with_audit(
  UUID, TEXT, UUID, UUID, NUMERIC(14,2), TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.resolve_migration_review_with_audit(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, NUMERIC(14,2), NUMERIC(14,2), TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.refresh_snapshot_with_audit(
  UUID, JSONB, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;

-- ── Functions from 20260907020200_settlement_rpcs.sql (no REVOKE in original) ──
REVOKE ALL ON FUNCTION public.process_merchant_settlement(
  UUID, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.reject_settlement(
  UUID, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.mark_settlement_success(
  UUID, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.mark_settlement_failed(
  UUID, TEXT
) FROM PUBLIC;

-- ── Functions from 20260908000000_merchant_multi_currency.sql ──
-- (CREATE OR REPLACE without REVOKE — re-exposed the functions)
-- Note: process_merchant_settlement now has an extra p_currency param.
--       We revoke BOTH signatures (old and new) to be safe.
REVOKE ALL ON FUNCTION public.process_merchant_settlement(
  UUID, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.reject_settlement(
  UUID, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.mark_settlement_failed(
  UUID, TEXT
) FROM PUBLIC;

-- ── Functions from 20260907020100_extend_callback_merchant_ledger.sql ──
-- (CREATE OR REPLACE without REVOKE — re-exposed process_wallet_provider_callback)
REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(
  TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC;

-- ── Functions from 20260908000100_callback_ledger_currency.sql ──
-- (CREATE OR REPLACE without REVOKE — re-exposed process_wallet_provider_callback again)
REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(
  TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC;

-- ── Grant EXECUTE to service_role only (explicit) ──
-- This ensures the backend (which uses service_role) can still call these
-- functions, while anon and authenticated cannot.
GRANT EXECUTE ON FUNCTION public.swap_balances(
  UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC
) TO service_role;

GRANT EXECUTE ON FUNCTION public.transition_expense(
  UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

GRANT EXECUTE ON FUNCTION public.confirm_settlement(
  UUID, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.create_settlement_with_audit(
  UUID, TEXT, UUID, UUID, NUMERIC(14,2), TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_migration_review_with_audit(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, NUMERIC(14,2), NUMERIC(14,2), TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.refresh_snapshot_with_audit(
  UUID, JSONB, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.process_merchant_settlement(
  UUID, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC
) TO service_role;

GRANT EXECUTE ON FUNCTION public.process_merchant_settlement(
  UUID, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.reject_settlement(
  UUID, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.mark_settlement_success(
  UUID, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.mark_settlement_failed(
  UUID, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.process_wallet_provider_callback(
  TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;
