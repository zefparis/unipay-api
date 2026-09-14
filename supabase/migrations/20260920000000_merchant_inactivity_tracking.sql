-- ============================================================
-- Migration: merchant inactivity tracking + audit log
-- Version   : 20260920000000
-- Purpose   : Automatic sorting of merchants by activity level.
--             Distinguishes serious clients from curious
--             registrations that pollute the admin dashboard.
--
-- Lifecycle (only for merchants with kyc_status='pending' AND
-- volume=0; accounts with volume or approved KYC are never
-- concerned):
--   J0-J3   : active (normal)
--   J3      : reminder email #1 (soft)
--   J7      : → to_relaunch + reminder email #2 (direct)
--   J12     : reminder email #3 (warning before masking)
--   J14     : → inactive (hidden from default dashboard view)
--   J104    : soft-delete (deleted_at set)
--
-- If at any point the merchant submits KYC or makes a
-- transaction, they exit the lifecycle and return to active.
-- ============================================================

-- ── Inactivity status on merchants ───────────────────────────
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS inactivity_status text NOT NULL DEFAULT 'active'
    CHECK (inactivity_status IN ('active', 'to_relaunch', 'inactive')),
  ADD COLUMN IF NOT EXISTS inactivity_status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reminder_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN merchants.inactivity_status IS
  'Automatic inactivity classification: active (normal), to_relaunch (J7+, KYC pending, no volume), inactive (J14+, hidden from default dashboard). Independent from manual status (active/suspended).';

COMMENT ON COLUMN merchants.inactivity_status_changed_at IS
  'Timestamp of the last inactivity_status change by the cron sweep.';

COMMENT ON COLUMN merchants.last_reminder_sent_at IS
  'Timestamp of the last automatic reminder email sent by the inactivity cron.';

COMMENT ON COLUMN merchants.last_reminder_step IS
  'Highest reminder step sent: 0=none, 1=J3 soft, 2=J7 relance, 3=J12 warning. Reset to 0 when merchant exits the lifecycle.';

COMMENT ON COLUMN merchants.deleted_at IS
  'Soft-delete timestamp set at J104 (90 days after inactive). Soft-deleted merchants are excluded from all queries by default.';

-- Partial index: only non-active inactivity statuses (small, fast)
CREATE INDEX IF NOT EXISTS idx_merchants_inactivity_status
  ON merchants (inactivity_status)
  WHERE inactivity_status != 'active';

-- Partial index: soft-deleted merchants
CREATE INDEX IF NOT EXISTS idx_merchants_deleted_at
  ON merchants (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ── Audit log table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merchant_inactivity_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid        NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  action      text        NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.merchant_inactivity_log IS
  'Audit trail for all automatic merchant inactivity actions (reminders, status changes, soft-deletes, reactivations).';

CREATE INDEX IF NOT EXISTS idx_merchant_inactivity_log_merchant_id
  ON public.merchant_inactivity_log (merchant_id);

CREATE INDEX IF NOT EXISTS idx_merchant_inactivity_log_created_at
  ON public.merchant_inactivity_log (created_at DESC);

-- RLS: admin-only (service role bypasses RLS)
ALTER TABLE public.merchant_inactivity_log ENABLE ROW LEVEL SECURITY;
