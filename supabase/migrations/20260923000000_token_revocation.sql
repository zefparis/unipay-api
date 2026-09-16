-- ============================================================
-- H2 remediation: JWT session revocation via token_version
-- ============================================================
-- Closes the vulnerability where changing password or PIN did not
-- invalidate existing JWTs, preventing users from expelling an
-- attacker after account compromise.
--
-- Mechanism:
--   1. Add token_version column to merchants and wallet_users
--   2. JWTs include token_version at signing time
--   3. Auth middleware compares JWT token_version with DB token_version
--   4. Security events (password reset, PIN change, admin block/suspend)
--      increment token_version, invalidating all existing tokens
--
-- Pre-migration tokens (without token_version claim) are treated as
-- version 0 by the verification logic, maintaining backward
-- compatibility without forcing a global logout at deployment.
--
-- Login does NOT increment token_version (multi-session allowed).

-- ── 1. token_version on merchants ─────────────────────────────
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.merchants.token_version IS
  'JWT revocation version. Incremented on password reset, admin suspend. JWTs with a stale token_version are rejected with 401 TOKEN_REVOKED. Login does NOT increment (multi-session allowed). Pre-migration tokens without this claim are treated as version 0.';

-- ── 2. token_version on wallet_users ──────────────────────────
ALTER TABLE public.wallet_users
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.wallet_users.token_version IS
  'JWT revocation version. Incremented on PIN change, admin block. JWTs (access + refresh) with a stale token_version are rejected with 401 TOKEN_REVOKED. Login does NOT increment (multi-session allowed). Pre-migration tokens without this claim are treated as version 0.';

-- ── 3. Atomic increment RPCs ─────────────────────────────────
-- Avoids TOCTOU on read-then-write in application code.
CREATE OR REPLACE FUNCTION public.increment_merchant_token_version(
  p_merchant_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_version INTEGER;
BEGIN
  UPDATE public.merchants
  SET token_version = token_version + 1
  WHERE id = p_merchant_id
  RETURNING token_version INTO v_new_version;

  IF v_new_version IS NULL THEN
    RAISE EXCEPTION 'MERCHANT_NOT_FOUND';
  END IF;

  RETURN v_new_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_wallet_token_version(
  p_wallet_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_version INTEGER;
BEGIN
  UPDATE public.wallet_users
  SET token_version = token_version + 1
  WHERE id = p_wallet_id
  RETURNING token_version INTO v_new_version;

  IF v_new_version IS NULL THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN v_new_version;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_merchant_token_version TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_wallet_token_version TO service_role;
