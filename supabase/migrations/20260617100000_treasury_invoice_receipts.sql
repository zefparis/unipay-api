-- ============================================================
-- Migration: 20260617100000_treasury_invoice_receipts
-- Purpose  : Extend treasury_crypto_receipts to support pending
--            invoice receipts before tx_hash arrives.
--            Add treasury_audit_log for full traceability.
-- ============================================================

-- 1. Make tx_hash nullable (pending receipts have no hash yet)
ALTER TABLE public.treasury_crypto_receipts
  ALTER COLUMN tx_hash DROP NOT NULL;

-- 2. Make received_at nullable (only set when payment arrives)
ALTER TABLE public.treasury_crypto_receipts
  ALTER COLUMN received_at DROP NOT NULL,
  ALTER COLUMN received_at DROP DEFAULT;

-- 3. Change status default from 'received' to 'pending'
ALTER TABLE public.treasury_crypto_receipts
  ALTER COLUMN status SET DEFAULT 'pending';

-- 4. Add new workflow columns
ALTER TABLE public.treasury_crypto_receipts
  ADD COLUMN IF NOT EXISTS expected_amount   NUMERIC(24,6),
  ADD COLUMN IF NOT EXISTS received_amount   NUMERIC(24,6),
  ADD COLUMN IF NOT EXISTS receiving_address TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_at      TIMESTAMPTZ;

-- 5. Backfill expected_amount from the existing amount column
UPDATE public.treasury_crypto_receipts
  SET expected_amount = amount
  WHERE expected_amount IS NULL;

-- 6. Extend status CHECK to include 'cancelled'
--    Drop the auto-named constraint regardless of its exact name
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname   = 'treasury_crypto_receipts'
     AND n.nspname   = 'public'
     AND c.contype   = 'c'
     AND c.conname   ILIKE '%status%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.treasury_crypto_receipts DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.treasury_crypto_receipts
  ADD CONSTRAINT tcr_status_check
    CHECK (status IN ('pending', 'received', 'confirmed', 'converted', 'rejected', 'cancelled'));

-- 7. Extend network CHECK to include Polygon, Base, Arbitrum
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname   = 'treasury_crypto_receipts'
     AND n.nspname   = 'public'
     AND c.contype   = 'c'
     AND c.conname   ILIKE '%network%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.treasury_crypto_receipts DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.treasury_crypto_receipts
  ADD CONSTRAINT tcr_network_check
    CHECK (network IN ('BSC', 'ERC20', 'TRC20', 'Polygon', 'Base', 'Arbitrum'));

-- 8. Indexes for new filter columns
CREATE INDEX IF NOT EXISTS idx_tcr_payer_name
  ON public.treasury_crypto_receipts (payer_name)
  WHERE payer_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tcr_invoice_ref
  ON public.treasury_crypto_receipts (invoice_reference)
  WHERE invoice_reference IS NOT NULL;

-- ── Treasury Audit Log ────────────────────────────────────────────────────
-- Append-only log for all receipt lifecycle events.
-- No balance credits here. No outgoing payments.

CREATE TABLE IF NOT EXISTS public.treasury_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_label TEXT,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL DEFAULT 'treasury_crypto_receipt',
  entity_id   UUID        NOT NULL,
  before      JSONB,
  after       JSONB,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tal_entity_id
  ON public.treasury_audit_log (entity_id);

CREATE INDEX IF NOT EXISTS idx_tal_created_at
  ON public.treasury_audit_log (created_at DESC);

ALTER TABLE public.treasury_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.treasury_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.treasury_audit_log IS
  'Append-only audit trail for treasury crypto receipt operations.
   Completely independent of wallet_users — no balance is credited here.';
