-- ============================================================
-- Migration: track the merchants.mode column
-- Version   : 20260918000000
-- Purpose   : The `mode` column (sandbox/live) was used in code
--             since the merchant mode feature was introduced but
--             was never tracked in a migration — it was added
--             manually to the production DB. This makes it official
--             and idempotent so fresh DBs and `supabase db push`
--             will have it. Default is 'sandbox' (new merchants
--             start in sandbox mode until KYC is approved).
-- ============================================================

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'sandbox'
  CHECK (mode IN ('sandbox', 'live'));

COMMENT ON COLUMN merchants.mode IS 'Merchant mode: sandbox (test, no real money) or live (real transactions). Defaults to sandbox; switched to live on KYC approval.';
