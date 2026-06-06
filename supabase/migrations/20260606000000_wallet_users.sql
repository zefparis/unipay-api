-- ============================================================
-- Migration: wallet_users + extend transactions for B2C wallet
-- Version   : 20260606000000
-- ============================================================

-- ── WALLET USERS ─────────────────────────────────────────────
CREATE TABLE wallet_users (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        varchar(20)   UNIQUE NOT NULL,
  full_name    varchar(100),
  pin_hash     varchar(255)  NOT NULL,
  kyc_level    smallint      NOT NULL DEFAULT 0,
  balance_cdf  numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance_cdf >= 0),
  is_verified  boolean       NOT NULL DEFAULT false,
  is_active    boolean       NOT NULL DEFAULT true,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX idx_wallet_users_phone ON wallet_users (phone);

-- ── updated_at trigger ────────────────────────────────────────
DROP TRIGGER IF EXISTS wallet_users_updated_at ON wallet_users;
CREATE TRIGGER wallet_users_updated_at
  BEFORE UPDATE ON wallet_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE wallet_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON wallet_users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Extend transactions: add wallet_user_id (nullable FK) ────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS wallet_user_id uuid
    REFERENCES wallet_users(id) ON DELETE SET NULL NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_user_id
  ON transactions (wallet_user_id)
  WHERE wallet_user_id IS NOT NULL;

-- ── Extend direction check to include 'p2p' ──────────────────
-- Drop auto-named constraint and recreate with p2p support
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_direction_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_direction_check
    CHECK (direction IN ('collect', 'payout', 'p2p'));
