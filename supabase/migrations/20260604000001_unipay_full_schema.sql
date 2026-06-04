-- ============================================================
-- Migration: unipay full schema (merchants + transactions + operators)
-- Version   : 20260604000001
-- Run via   : supabase db push
--             OR paste directly into Supabase SQL Editor
-- ============================================================

-- ── Drop stale tables from earlier migrations (CASCADE removes dependents) ──
DROP TABLE IF EXISTS api_keys    CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS operators   CASCADE;
DROP TABLE IF EXISTS merchants   CASCADE;

-- ── MERCHANTS ────────────────────────────────────────────────
CREATE TABLE merchants (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  email         text        UNIQUE NOT NULL,
  password_hash text        NOT NULL,
  phone         text,
  country       text        NOT NULL DEFAULT 'CD',
  api_key       text        UNIQUE,
  status        text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'suspended', 'pending')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── TRANSACTIONS ─────────────────────────────────────────────
CREATE TABLE transactions (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          uuid          REFERENCES merchants(id) ON DELETE RESTRICT,
  operator             text          NOT NULL
                                       CHECK (operator IN ('orange','airtel','afrimoney','vodacash','usdt')),
  phone                text          NOT NULL,
  amount               numeric(20,4) NOT NULL CHECK (amount > 0),
  fee                  numeric(20,4) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  net_amount           numeric(20,4) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  currency             text          NOT NULL DEFAULT 'CDF',
  reference            text,
  avada_transaction_id text,
  status               text          NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending','processing','success','failed','cancelled')),
  direction            text          NOT NULL
                                       CHECK (direction IN ('collect','payout')),
  metadata             jsonb         NOT NULL DEFAULT '{}',
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now()
);

-- ── OPERATORS (per-operator balance per merchant) ────────────
CREATE TABLE operators (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid          REFERENCES merchants(id) ON DELETE CASCADE,
  operator      text          NOT NULL
                                CHECK (operator IN ('orange','airtel','afrimoney','vodacash','usdt')),
  balance_cdf   numeric(20,4) NOT NULL DEFAULT 0,
  password_hash text,
  status        text          NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, operator)
);

-- ── API KEYS ─────────────────────────────────────────────────
CREATE TABLE api_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key_hash     text        NOT NULL UNIQUE,
  key_prefix   text        NOT NULL,
  label        text        NOT NULL DEFAULT 'default',
  is_active    boolean     NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_id
  ON transactions (merchant_id);

CREATE INDEX IF NOT EXISTS idx_transactions_status
  ON transactions (status);

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON transactions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_avada_id
  ON transactions (avada_transaction_id)
  WHERE avada_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_reference
  ON transactions (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operators_merchant_id
  ON operators (merchant_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_merchant_id
  ON api_keys (merchant_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash
  ON api_keys (key_hash);

-- ── UPDATED_AT trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS merchants_updated_at ON merchants;
CREATE TRIGGER merchants_updated_at
  BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS transactions_updated_at ON transactions;
CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
ALTER TABLE merchants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators    ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys     ENABLE ROW LEVEL SECURITY;

-- Service role (used by the API server) bypasses RLS on all tables
CREATE POLICY "service_role_all" ON merchants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all" ON transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all" ON operators
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all" ON api_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);
