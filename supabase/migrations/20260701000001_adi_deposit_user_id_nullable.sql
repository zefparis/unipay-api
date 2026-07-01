-- ============================================================
-- Migration: make user_id nullable in adi_deposit_events
-- Version  : 20260701000001
-- Reason   : PredictStreet deposit webhook does not send user_id.
--            User resolution happens later via from_address lookup.
-- Run via  : Supabase SQL Editor or supabase db push
-- ============================================================

ALTER TABLE adi_deposit_events
  ALTER COLUMN user_id DROP NOT NULL;
