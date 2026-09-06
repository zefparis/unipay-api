-- ============================================================
-- Add template_label to support_messages for email tracking
-- ============================================================
-- When an admin sends a templated email (e.g. "Relance KYC"), the
-- template label is stored here so we can count how many times each
-- template was sent to a given merchant. NULL for free-form messages.

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS template_label text;

COMMENT ON COLUMN public.support_messages.template_label IS
  'Label of the email template used (e.g. "Relance KYC"), NULL for free-form messages.';

-- Index for efficient per-merchant template counts
CREATE INDEX IF NOT EXISTS idx_support_messages_template_label
  ON public.support_messages (template_label)
  WHERE template_label IS NOT NULL;
