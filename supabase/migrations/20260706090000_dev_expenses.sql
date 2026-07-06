-- ============================================================
-- Migration: 20260706090000_dev_expenses
-- Purpose  : Dev Expenses Tracker — monthly infra cost tracking
--            (Render, Vercel, Supabase, Cloudflare, Anthropic)
--            Paid by third party (Benoît/HMH), reported to
--            tekkbridge via tokenized read-only links.
-- ============================================================

-- ── Table: dev_expenses ─────────────────────────────────────
-- One row per service per billing month.

CREATE TABLE IF NOT EXISTS public.dev_expenses (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  service       TEXT         NOT NULL
    CHECK (service IN ('render','vercel','supabase','cloudflare','anthropic')),
  billing_month DATE         NOT NULL,
  amount_usd    NUMERIC(10,2) NOT NULL,
  source        TEXT         NOT NULL DEFAULT 'manual'
    CHECK (source IN ('api_pull','manual')),
  invoice_url   TEXT,
  status        TEXT         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','reconciled')),
  paid_at       TIMESTAMPTZ,
  payment_ref   TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (service, billing_month)
);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_billing_month
  ON public.dev_expenses (billing_month DESC);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_status
  ON public.dev_expenses (status);

-- ── Table: dev_expenses_reports ─────────────────────────────
-- One row per billing month, generated when all 5 services are
-- filled in. Contains a unique share_token for the public link.

CREATE TABLE IF NOT EXISTS public.dev_expenses_reports (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_month  DATE         NOT NULL UNIQUE,
  total_usd      NUMERIC(10,2) NOT NULL,
  report_pdf_url TEXT,
  share_token    TEXT         NOT NULL UNIQUE
    DEFAULT encode(gen_random_bytes(24), 'hex'),
  generated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_reports_token
  ON public.dev_expenses_reports (share_token);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_reports_month
  ON public.dev_expenses_reports (billing_month DESC);

-- ── RLS: service_role only for write ────────────────────────
-- No public read — the public endpoint checks share_token
-- server-side and returns JSON, never direct table access.

ALTER TABLE public.dev_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dev_expenses_reports ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS "dev_expenses_service_role_all" ON public.dev_expenses;
DROP POLICY IF EXISTS "dev_expenses_reports_service_role_all" ON public.dev_expenses_reports;

CREATE POLICY "dev_expenses_service_role_all"
  ON public.dev_expenses
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "dev_expenses_reports_service_role_all"
  ON public.dev_expenses_reports
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── updated_at trigger ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dev_expenses_updated_at ON public.dev_expenses;

CREATE TRIGGER trg_dev_expenses_updated_at
  BEFORE UPDATE ON public.dev_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── Storage bucket: dev-expenses-invoices ───────────────────
-- Private bucket — access via signed URLs only (30-day expiry).

INSERT INTO storage.buckets (id, name, public)
  VALUES ('dev-expenses-invoices', 'dev-expenses-invoices', false)
  ON CONFLICT (id) DO NOTHING;

-- Storage policies: service_role only
DROP POLICY IF EXISTS "dev_expenses_invoices_service_role_all" ON storage.objects;

CREATE POLICY "dev_expenses_invoices_service_role_all"
  ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'dev-expenses-invoices')
  WITH CHECK (bucket_id = 'dev-expenses-invoices');

COMMENT ON TABLE public.dev_expenses IS
  'Monthly dev infra costs per service. RLS: service_role only.';
COMMENT ON TABLE public.dev_expenses_reports IS
  'Monthly aggregated report with share_token for read-only public link.';
