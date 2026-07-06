-- ============================================================
-- Migration: 20260706120000_dev_expenses_v2
-- Purpose  : Evolve Dev Expenses Tracker from a fixed 5-service
--            cloud tracker to a generalised creditor/invoice registry.
--            Any creditor type (cloud, freelance, company, individual),
--            free text category, project reference, due dates.
-- NOTE     : Does NOT modify 20260706090000_dev_expenses.sql.
-- ============================================================

-- ── 1. CREDITORS TABLE ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.creditors (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  entity_type      TEXT        NOT NULL
    CONSTRAINT creditors_entity_type_check
    CHECK (entity_type IN ('cloud_provider','freelance','company','individual','other')),
  contact_email    TEXT,
  payment_method   TEXT
    CONSTRAINT creditors_payment_method_check
    CHECK (payment_method IN ('bank_transfer','mobile_money','crypto','other')),
  payment_details  JSONB,
  default_category TEXT,
  notes            TEXT,
  active           BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.creditors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "creditors_service_role_all" ON public.creditors;
CREATE POLICY "creditors_service_role_all"
  ON public.creditors FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.creditors IS
  'Creditor registry: cloud providers, freelancers, companies, individuals. Soft-delete via active=false.';

-- ── 2. SEED CREDITORS for existing cloud services ──────────
INSERT INTO public.creditors (name, entity_type, default_category) VALUES
  ('Render',     'cloud_provider', 'Infra Cloud'),
  ('Vercel',     'cloud_provider', 'Infra Cloud'),
  ('Supabase',   'cloud_provider', 'Infra Cloud'),
  ('Cloudflare', 'cloud_provider', 'Infra Cloud'),
  ('Anthropic',  'cloud_provider', 'AI API')
ON CONFLICT DO NOTHING;

-- ── 3. ALTER TABLE dev_expenses ────────────────────────────

-- 3a. Drop old UNIQUE constraint on (service, billing_month)
ALTER TABLE public.dev_expenses
  DROP CONSTRAINT IF EXISTS dev_expenses_service_billing_month_key;

-- 3b. Drop old CHECK constraint on service column
ALTER TABLE public.dev_expenses
  DROP CONSTRAINT IF EXISTS dev_expenses_service_check;

-- 3c. Rename service → category (only if column 'service' exists and 'category' doesn't)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dev_expenses' AND column_name = 'service'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dev_expenses' AND column_name = 'category'
  ) THEN
    ALTER TABLE public.dev_expenses RENAME COLUMN service TO category;
  END IF;
END $$;

-- 3d. Normalise category values to Title Case (Render, Vercel, etc.)
UPDATE public.dev_expenses
SET category = initcap(category)
WHERE category ~ '^[a-z]';

-- 3e. Add new columns (IF NOT EXISTS guards make this idempotent)
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS creditor_id    UUID
    REFERENCES public.creditors(id),
  ADD COLUMN IF NOT EXISTS project_ref    TEXT
    CONSTRAINT dev_expenses_project_ref_len CHECK (char_length(project_ref) <= 200),
  ADD COLUMN IF NOT EXISTS due_date       DATE,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT
    CONSTRAINT dev_expenses_invoice_number_len CHECK (char_length(invoice_number) <= 100),
  ADD COLUMN IF NOT EXISTS funded_by      TEXT NOT NULL DEFAULT 'tekkbridge',
  ADD COLUMN IF NOT EXISTS paid_by        TEXT NOT NULL DEFAULT 'benoit';

-- 3f. Link existing rows to creditors by matching category name
UPDATE public.dev_expenses de
SET creditor_id = c.id
FROM public.creditors c
WHERE lower(c.name) = lower(de.category)
  AND de.creditor_id IS NULL;

-- 3g. Partial unique index: at most one api_pull row per (creditor, billing_month)
--     Multiple manual invoices per creditor per month are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS dev_expenses_creditor_month_auto_uq
  ON public.dev_expenses (creditor_id, billing_month)
  WHERE source = 'api_pull';

-- 3h. Index for due_date queries (upcoming / overdue)
CREATE INDEX IF NOT EXISTS idx_dev_expenses_due_date
  ON public.dev_expenses (due_date)
  WHERE status != 'paid';

-- 3i. Index for creditor_id lookups
CREATE INDEX IF NOT EXISTS idx_dev_expenses_creditor_id
  ON public.dev_expenses (creditor_id);

-- ── 4. VIEW dev_expenses_with_status ───────────────────────
-- Exposes a live is_overdue flag (dynamically computed) and
-- enriches each row with the linked creditor's key fields.

CREATE OR REPLACE VIEW public.dev_expenses_with_status AS
SELECT
  de.*,
  (
    de.due_date IS NOT NULL
    AND de.due_date < CURRENT_DATE
    AND de.status != 'paid'
  )::boolean                              AS is_overdue,
  c.name                                  AS creditor_name,
  c.entity_type                           AS creditor_entity_type,
  c.payment_method                        AS creditor_payment_method,
  c.payment_details                       AS creditor_payment_details
FROM public.dev_expenses de
LEFT JOIN public.creditors c ON c.id = de.creditor_id;

COMMENT ON VIEW public.dev_expenses_with_status IS
  'dev_expenses enriched with creditor info and live is_overdue flag (due_date < today AND status != paid).';

-- ── Update table comment ────────────────────────────────────
COMMENT ON TABLE public.dev_expenses IS
  'Dev infrastructure & service invoices. category is free-text. creditor_id FK to creditors. RLS: service_role only.';
