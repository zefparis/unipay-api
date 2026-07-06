-- ══════════════════════════════════════════════════════════════
-- Migration: dev_expenses v3 — archivage + table quotes
-- ══════════════════════════════════════════════════════════════

-- ── 1. ALTER dev_expenses : colonnes archivage ──────────────
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS archived    boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Index composé pour les requêtes "vue active" (upcoming / list par défaut)
CREATE INDEX IF NOT EXISTS idx_dev_expenses_active_due
  ON public.dev_expenses (status, due_date)
  WHERE archived = false;

COMMENT ON COLUMN public.dev_expenses.archived IS
  'Soft-archive flag. Only paid/reconciled expenses may be archived. Excluded from reports and upcoming views.';
COMMENT ON COLUMN public.dev_expenses.archived_at IS
  'Timestamp at which the expense was archived. NULL when archived=false.';

-- ── 1b. Refresh view to include new archived columns ───────
-- DROP + CREATE (not CREATE OR REPLACE) because de.* now expands with
-- 2 extra columns, shifting is_overdue's position — PG rejects that.
DROP VIEW IF EXISTS public.dev_expenses_with_status;
CREATE VIEW public.dev_expenses_with_status AS
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

-- ── 2. TABLE quotes (devis) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.quotes (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  creditor_id          uuid          REFERENCES public.creditors(id) ON DELETE SET NULL,
  creditor_name        text,
  project_ref          text          NOT NULL,
  category             text,
  amount_usd           numeric(10,2) NOT NULL CHECK (amount_usd >= 0),
  description          text,
  status               text          NOT NULL DEFAULT 'draft'
    CONSTRAINT quotes_status_check
      CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  valid_until          date,
  quote_file_url       text,
  converted_expense_id uuid          REFERENCES public.dev_expenses(id) ON DELETE SET NULL,
  notes                text,
  created_at           timestamptz   DEFAULT now(),
  updated_at           timestamptz   DEFAULT now()
);

COMMENT ON TABLE public.quotes IS
  'Estimates/quotes for new projects. Lifecycle: draft → sent → accepted/rejected. '
  'On accept: a dev_expense row is created and linked via converted_expense_id.';
COMMENT ON COLUMN public.quotes.converted_expense_id IS
  'Populated when status=accepted. References the dev_expense created from this quote.';
COMMENT ON COLUMN public.quotes.creditor_name IS
  'Free-text creditor name if creditor_id is NULL (creditor not yet in the creditors table).';

-- ── 3. RLS on quotes (service_role only, same policy as dev_expenses) ──
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quotes_service_role_all" ON public.quotes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. Indexes on quotes ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quotes_status
  ON public.quotes (status);

CREATE INDEX IF NOT EXISTS idx_quotes_creditor_id
  ON public.quotes (creditor_id);

-- Partial index: quickly find sent quotes past their valid_until date
CREATE INDEX IF NOT EXISTS idx_quotes_sent_valid_until
  ON public.quotes (valid_until)
  WHERE status = 'sent';

-- ── 5. Refresh PostgREST schema cache ───────────────────────
NOTIFY pgrst, 'reload schema';
