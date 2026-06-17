-- ════════════════════════════════════════════════════════════════════════════
-- Migration: receipt archive / soft-delete support
-- Adds archiving columns to treasury_crypto_receipts so admins can hide
-- old test/rejected receipts from the operational view without losing the
-- audit history.  Hard-delete remains restricted to safe draft receipts.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.treasury_crypto_receipts
  ADD COLUMN IF NOT EXISTS is_archived    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by    TEXT,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

/* Partial index — only indexes archived rows (small, fast for default view) */
CREATE INDEX IF NOT EXISTS idx_treasury_crypto_receipts_is_archived
  ON public.treasury_crypto_receipts (is_archived)
  WHERE is_archived = TRUE;

/* Default operational view: non-archived rows */
CREATE INDEX IF NOT EXISTS idx_treasury_crypto_receipts_not_archived
  ON public.treasury_crypto_receipts (created_at DESC)
  WHERE is_archived = FALSE;

COMMENT ON COLUMN public.treasury_crypto_receipts.is_archived IS
  'When TRUE, the receipt is hidden from the default operational list view.
   Archived receipts retain their full audit history and can be restored.
   Hard delete is reserved for test/draft receipts with no payment evidence.';

COMMENT ON COLUMN public.treasury_crypto_receipts.archive_reason IS
  'Free-text reason supplied by the admin at archive time (min 5 chars).';
