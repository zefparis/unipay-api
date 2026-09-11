-- ============================================================
-- Migration: merchant KYC document uploads
-- Version   : 20260917000000
-- Purpose   : Store storage paths for RCCM / ID NAT / legal
--             representative ID documents submitted by merchants
--             during KYC. Reuses the same Supabase Storage
--             approach as wallet KYC (kyc-docs) and dev-expenses
--             (dev-expenses-invoices) — no new storage system.
-- ============================================================

-- ── Columns on merchants ───────────────────────────────────
-- Storage paths (private bucket, served via signed URLs to admin).
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS rccm_file_url   text,
  ADD COLUMN IF NOT EXISTS idnat_file_url  text,
  ADD COLUMN IF NOT EXISTS rep_id_file_url text;

COMMENT ON COLUMN merchants.rccm_file_url   IS 'Storage path in merchant-kyc-docs bucket for the scanned RCCM document.';
COMMENT ON COLUMN merchants.idnat_file_url  IS 'Storage path in merchant-kyc-docs bucket for the scanned ID NAT document.';
COMMENT ON COLUMN merchants.rep_id_file_url IS 'Storage path in merchant-kyc-docs bucket for the legal representative ID document.';

-- ── Storage bucket: merchant-kyc-docs ──────────────────────
-- Private bucket — access via signed URLs only (30-day expiry),
-- matching the dev-expenses-invoices convention.

INSERT INTO storage.buckets (id, name, public)
  VALUES ('merchant-kyc-docs', 'merchant-kyc-docs', false)
  ON CONFLICT (id) DO NOTHING;

-- Storage policies: service_role only (backend uploads + signs URLs)
DROP POLICY IF EXISTS "merchant_kyc_docs_service_role_all" ON storage.objects;

CREATE POLICY "merchant_kyc_docs_service_role_all"
  ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'merchant-kyc-docs')
  WITH CHECK (bucket_id = 'merchant-kyc-docs');
