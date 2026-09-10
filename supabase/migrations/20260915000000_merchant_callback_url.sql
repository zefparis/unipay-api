-- ════════════════════════════════════════════════════════════════════════════
-- Add callback_url column to merchants table
--
-- Purpose: Merchants need a configurable callback URL where UniPay sends
-- transaction status notifications (success/failure callbacks). Previously
-- the merchants table had no callback_url column — the old operators table
-- (001_init.sql) had webhook_url but that table was dropped and recreated
-- without it in 20260604000001_unipay_full_schema.sql.
--
-- This migration adds callback_url as an optional text column. The admin
-- can set it via the merchant detail page, and the "Tester le callback"
-- feature sends a test POST to verify the endpoint responds correctly.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS callback_url text;

COMMENT ON COLUMN public.merchants.callback_url IS
  'Merchant webhook URL for transaction status callbacks. Optional. Set by admin via merchant detail page.';
