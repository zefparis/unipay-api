-- ============================================================
-- Conformité KYC obligatoire (étape 6)
-- access_status + merchant_kyc_events
-- ============================================================
-- access_status = état d'accès à la plateforme (indépendant de
-- kyc_status qui décrit le DOSSIER et de status qui décrit le compte) :
--   active         → accès complet (dossier validé)
--   kyc_required   → dossier complet envoyé, en attente de validation
--   suspended_kyc  → dossier incomplet → suspension réversible
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'kyc_required', 'suspended_kyc')),
  ADD COLUMN IF NOT EXISTS access_status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_status_reason TEXT;

CREATE INDEX IF NOT EXISTS merchants_access_status_idx
  ON public.merchants (access_status)
  WHERE access_status <> 'active';

-- Journal d'événements KYC (un event par transition, traçable)
CREATE TABLE IF NOT EXISTS public.merchant_kyc_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',   -- 'system' | 'admin' | 'merchant'
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_kyc_events_merchant_idx
  ON public.merchant_kyc_events (merchant_id, created_at DESC);

REVOKE ALL ON public.merchant_kyc_events FROM PUBLIC;
GRANT SELECT, INSERT ON public.merchant_kyc_events TO service_role;

-- Cas c : actifs sous préavis — deadline à J+7 sans coupure immédiate
ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS kyc_deadline TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS merchants_kyc_deadline_idx
  ON public.merchants (kyc_deadline)
  WHERE kyc_deadline IS NOT NULL;
