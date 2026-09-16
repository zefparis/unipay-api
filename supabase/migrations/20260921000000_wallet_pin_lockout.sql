-- ============================================================
-- Migration: wallet_users PIN lockout columns
-- Version   : 20260921000000
--
-- Adds brute-force protection for the wallet PIN (4-8 digits).
-- After MAX_FAILED_PIN_ATTEMPTS (5) consecutive failures the account
-- is locked for an escalating duration (15 min → 1 h → 24 h →
-- permanent, requiring admin unlock).
--
-- Columns:
--   failed_pin_attempts   — consecutive failed PIN attempts since
--                           last success or last lockout (resets to 0
--                           on lock and on successful login).
--   locked_until          — timestamp until which login is refused.
--                           NULL = not locked.
--   pin_lockout_count     — how many times the account has been
--                           locked. Drives escalation. Resets to 0
--                           on successful login.
-- ============================================================

ALTER TABLE wallet_users
  ADD COLUMN IF NOT EXISTS failed_pin_attempts smallint NOT NULL DEFAULT 0;

ALTER TABLE wallet_users
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

ALTER TABLE wallet_users
  ADD COLUMN IF NOT EXISTS pin_lockout_count smallint NOT NULL DEFAULT 0;

-- Index to help admin queries find locked accounts.
CREATE INDEX IF NOT EXISTS idx_wallet_users_locked_until
  ON wallet_users (locked_until)
  WHERE locked_until IS NOT NULL;
