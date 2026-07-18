-- ============================================================
-- Migration: adi_deposit_events table
-- Purpose  : Track PredictStreet (ADI) deposit webhook events.
--            Created here because the table was originally added
--            directly in production without a migration file.
--            Subsequent migrations (20260701000000, 20260701000001)
--            ALTER this table.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.adi_deposit_events (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid          REFERENCES public.wallet_users(id) ON DELETE SET NULL,
  amount_usd      numeric(20,4) NOT NULL CHECK (amount_usd > 0),
  tx_hash         text,
  status          text          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'confirmed', 'failed')),
  metadata        jsonb         NOT NULL DEFAULT '{}',
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adi_deposit_events_user_id
  ON public.adi_deposit_events (user_id);

CREATE INDEX IF NOT EXISTS idx_adi_deposit_events_status
  ON public.adi_deposit_events (status);

CREATE INDEX IF NOT EXISTS idx_adi_deposit_events_created_at
  ON public.adi_deposit_events (created_at DESC);

ALTER TABLE public.adi_deposit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.adi_deposit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.adi_deposit_events IS
  'PredictStreet (ADI) deposit webhook events. user_id may be NULL when sender address is unknown.';
