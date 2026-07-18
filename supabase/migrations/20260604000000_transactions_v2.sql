-- ============================================================
-- Migration: transactions v2 + operators update for Avada integration
-- Run: supabase db push  (or apply via Supabase dashboard)
-- ============================================================

-- ── operators: add password_hash + balance_cdf ───────────────
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS balance_cdf    numeric(20, 4) NOT NULL DEFAULT 0;

-- ── Drop old transactions table and recreate with new schema ─
-- NOTE: in production with existing data, use ALTER TABLE instead.
DROP TABLE IF EXISTS transactions;

CREATE TABLE transactions (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id           uuid          NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  operator              text          NOT NULL
                          CHECK (operator IN ('orange', 'airtel', 'vodacash', 'afrimoney', 'usdt')),
  phone                 text          NOT NULL,
  amount                numeric(20,4) NOT NULL CHECK (amount > 0),
  fee                   numeric(20,4) NOT NULL CHECK (fee >= 0),
  net_amount            numeric(20,4) NOT NULL CHECK (net_amount >= 0),
  currency              text          NOT NULL DEFAULT 'CDF',
  reference             text,
  avada_transaction_id  text,
  status                text          NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'success', 'failed', 'cancelled')),
  direction             text          NOT NULL
                          CHECK (direction IN ('collect', 'payout')),
  metadata              jsonb         NOT NULL DEFAULT '{}',
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX idx_transactions_merchant_id
  ON transactions (merchant_id);

CREATE INDEX idx_transactions_avada_id
  ON transactions (avada_transaction_id)
  WHERE avada_transaction_id IS NOT NULL;

CREATE INDEX idx_transactions_reference
  ON transactions (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX idx_transactions_status
  ON transactions (status);

CREATE INDEX idx_transactions_created_at
  ON transactions (created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_updated_at ON transactions;
CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row Level Security ────────────────────────────────────────
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Service role (used by the API) bypasses RLS
CREATE POLICY "service_role_all" ON transactions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
