-- ============================================================
-- Migration: 20260617210000_receipt_kind
-- Purpose  : Add receipt_kind to treasury_crypto_receipts to
--            distinguish invoice payments from internal
--            regularization entries.
--
--            internal_regularization entries reconcile on-chain
--            balance vs. accounting balance without representing
--            a new blockchain transaction.  They require notes
--            but do NOT require a tx_hash.
-- ============================================================

ALTER TABLE public.treasury_crypto_receipts
  ADD COLUMN IF NOT EXISTS receipt_kind TEXT NOT NULL DEFAULT 'invoice_payment';

-- Drop any existing receipt_kind check (idempotent)
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE t.relname = 'treasury_crypto_receipts'
     AND n.nspname = 'public'
     AND c.contype = 'c'
     AND c.conname ILIKE '%receipt_kind%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.treasury_crypto_receipts DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.treasury_crypto_receipts
  ADD CONSTRAINT tcr_receipt_kind_check
    CHECK (receipt_kind IN ('invoice_payment', 'test_payment', 'internal_regularization'));

CREATE INDEX IF NOT EXISTS idx_tcr_receipt_kind
  ON public.treasury_crypto_receipts (receipt_kind)
  WHERE receipt_kind != 'invoice_payment';

COMMENT ON COLUMN public.treasury_crypto_receipts.receipt_kind IS
  'invoice_payment (default), test_payment, or internal_regularization.
   internal_regularization: no tx_hash required; reconciles on-chain balance
   with accounting total. No blockchain transaction is created.';
