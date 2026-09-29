-- Minimal schema for running wallet-withdrawal migrations and tests on a
-- DISPOSABLE local PostgreSQL (never Supabase). Mirrors only the columns
-- referenced by:
--   20260914000000_unipesa_reconciliation.sql
--   20260929000000_wallet_withdraw_idempotency.sql
--   20260930000000_reconcile_pending_wallet_payouts.sql
-- Usage (see supabase/tests/README or the test files):
--   psql "$TEST_DATABASE_URL" -f supabase/tests/fixtures/minimal_schema.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.wallet_users (
  id uuid PRIMARY KEY, phone text UNIQUE NOT NULL, pin_hash text NOT NULL, kyc_level int DEFAULT 0,
  balance_cdf numeric DEFAULT 0, usd_balance numeric DEFAULT 0, is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY, wallet_user_id uuid, merchant_id uuid, settlement_request_id uuid,
  operator text, direction text, amount numeric, fee numeric DEFAULT 0, net_amount numeric,
  currency text DEFAULT 'CDF', phone text, reference text, blockchain_tx_hash text,
  avada_transaction_id text, status text, metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

CREATE TABLE IF NOT EXISTS public.provider_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text, provider_event_id text,
  transaction_id uuid, payload jsonb, created_at timestamptz DEFAULT now(),
  UNIQUE (provider, provider_event_id));

CREATE TABLE IF NOT EXISTS public.merchant_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, transaction_id uuid,
  type text, amount numeric, balance_after numeric, currency text DEFAULT 'CDF',
  created_at timestamptz DEFAULT now());

CREATE OR REPLACE FUNCTION public.mark_settlement_success(uuid, text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE OR REPLACE FUNCTION public.mark_settlement_failed(uuid, text)  RETURNS void LANGUAGE sql AS $$ SELECT $$;
