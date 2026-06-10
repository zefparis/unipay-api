-- Push subscriptions (device tokens for Web Push)
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.wallet_users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

-- In-app notification history
CREATE TABLE IF NOT EXISTS public.wallet_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.wallet_users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title_fr   TEXT NOT NULL,
  title_en   TEXT NOT NULL,
  body_fr    TEXT NOT NULL,
  body_en    TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallet_notifications_user_idx
  ON public.wallet_notifications (user_id, created_at DESC);

-- Notification preferences on wallet_users
ALTER TABLE public.wallet_users
  ADD COLUMN IF NOT EXISTS notif_enabled    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_deposit    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_transfer   BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_withdrawal BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_system     BOOLEAN DEFAULT TRUE;
