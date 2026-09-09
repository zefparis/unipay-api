-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260913000000_wallet_sensitive_sessions.sql
-- Purpose  : Local sensitive-session state for the wallet app, replacing the
--            previous dependency on hybrid-vector-api's pulseguard_sensitive_sessions
--            table for the security decision. The invalidation trigger (user
--            leaves the app > 30s) is unchanged; only the re-verification changes
--            from cognitive tests (which were never validated server-side) to a
--            PIN re-authentication verified against wallet_users.pin_hash.
--
-- This table is owned entirely by unipay-api. No RLS — access is mediated by
-- the backend (requireActiveWallet + session ownership checks).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.wallet_sensitive_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        UUID NOT NULL REFERENCES public.wallet_users(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'invalidated')),
  blurred_at      TIMESTAMPTZ,
  suspended_at    TIMESTAMPTZ,
  invalidated_at  TIMESTAMPTZ,
  tolerance_ms    INTEGER NOT NULL DEFAULT 30000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active/suspended session per (wallet_id, session_id) at a time.
-- Multiple historical rows are allowed (status='invalidated' is kept for audit).
CREATE UNIQUE INDEX IF NOT EXISTS wallet_sensitive_sessions_active_uniq
  ON public.wallet_sensitive_sessions (wallet_id, session_id)
  WHERE status IN ('active', 'suspended');

CREATE INDEX IF NOT EXISTS wallet_sensitive_sessions_wallet_idx
  ON public.wallet_sensitive_sessions (wallet_id);

CREATE INDEX IF NOT EXISTS wallet_sensitive_sessions_status_idx
  ON public.wallet_sensitive_sessions (status)
  WHERE status IN ('active', 'suspended');
