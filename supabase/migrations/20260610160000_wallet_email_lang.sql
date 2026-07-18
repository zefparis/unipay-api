-- ============================================================
-- Migration: wallet_users email + lang columns
-- Purpose  : Optional email for transactional notifications,
--            language preference for i18n emails (fr/en).
-- ============================================================

ALTER TABLE public.wallet_users
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS lang text DEFAULT 'fr';
