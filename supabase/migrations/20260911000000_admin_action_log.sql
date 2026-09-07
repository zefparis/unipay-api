-- ============================================================
-- Migration: admin_action_log
-- Purpose  : Audit trail for sensitive admin mutations.
--            Solo-admin context: actor is always 'admin' (no
--            individual admin identity), but the log captures
--            WHAT was done, on WHICH resource, and WHEN — enough
--            for post-incident investigation.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.admin_action_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short action identifier, e.g. 'merchant.suspend', 'wallet_user.block',
  -- 'kyc.approve', 'wallet.balance_adjust', 'api_key.regenerate'
  action          text NOT NULL,
  -- Resource type: 'merchant', 'wallet_user', 'settlement', 'api_key', etc.
  resource_type   text NOT NULL,
  -- UUID of the affected resource (nullable for actions that don't target a single resource)
  resource_id     uuid,
  -- Safe summary of the request body — NEVER contains secrets, passwords,
  -- or full API keys. Only business-relevant fields (amount, reason, mode, etc.)
  request_summary jsonb DEFAULT '{}'::jsonb,
  -- Always 'admin' in the current solo-admin context.
  -- Reserved for future multi-admin identity.
  actor           text NOT NULL DEFAULT 'admin',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for chronological queries
CREATE INDEX IF NOT EXISTS idx_admin_action_log_created_at
  ON public.admin_action_log (created_at DESC);

-- Index for filtering by action
CREATE INDEX IF NOT EXISTS idx_admin_action_log_action
  ON public.admin_action_log (action);

-- Index for filtering by resource
CREATE INDEX IF NOT EXISTS idx_admin_action_log_resource
  ON public.admin_action_log (resource_type, resource_id);

-- RLS: only the backend service role can read/write.
-- Admin access is via x-admin-secret at the API layer, not via
-- direct Supabase connections from the browser.
ALTER TABLE public.admin_action_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (Supabase default for service_role key).
-- No policy needed for anon/authenticated — the table is only
-- accessed by the backend using the service role key.
