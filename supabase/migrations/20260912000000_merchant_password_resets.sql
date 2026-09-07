-- ============================================================
-- Migration: merchant_password_resets
-- Purpose  : Secure password reset flow for merchants.
--            Stores hashed reset tokens (never plaintext) with
--            30-minute expiry and single-use enforcement.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.merchant_password_resets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  -- Hashed token (bcrypt or sha256) — NEVER the plaintext token
  token_hash   text NOT NULL,
  -- 30 minutes after creation
  expires_at   timestamptz NOT NULL,
  -- Set when the token is used (single-use enforcement)
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Index for lookup by merchant (to invalidate pending tokens on reset)
CREATE INDEX IF NOT EXISTS idx_merchant_password_resets_merchant_id
  ON public.merchant_password_resets (merchant_id);

-- Index for token verification lookup
CREATE INDEX IF NOT EXISTS idx_merchant_password_resets_token_hash
  ON public.merchant_password_resets (token_hash);

-- Enable RLS
ALTER TABLE public.merchant_password_resets ENABLE ROW LEVEL SECURITY;

-- RLS: only the backend service role can access this table
-- (no direct client access — all operations go through API routes)
CREATE POLICY "service_role full access to merchant_password_resets"
  ON public.merchant_password_resets
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Deny all access to anon and authenticated roles
CREATE POLICY "deny anon access to merchant_password_resets"
  ON public.merchant_password_resets
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "deny authenticated access to merchant_password_resets"
  ON public.merchant_password_resets
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
