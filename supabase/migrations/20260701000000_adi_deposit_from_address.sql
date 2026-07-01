-- ============================================================
-- Migration: add from_address column to adi_deposit_events
-- Version  : 20260701000000
-- Reason   : PredictStreet deposit webhook now sends sender
--            wallet address; stored for reconciliation.
-- Run via  : Supabase SQL Editor or supabase db push
-- ============================================================

ALTER TABLE adi_deposit_events
  ADD COLUMN IF NOT EXISTS from_address text;
