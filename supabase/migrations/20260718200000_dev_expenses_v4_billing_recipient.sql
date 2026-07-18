-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260718200000_dev_expenses_v4_billing_recipient.sql
-- Purpose  : Additive changes — expense_entities enrichment + billing_recipient
--            on dev_expenses with snapshot for historical fidelity.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. ENRICH expense_entities ───────────────────────────────────────────────

ALTER TABLE public.expense_entities
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS phone        TEXT,
  ADD COLUMN IF NOT EXISTS address      TEXT,
  ADD COLUMN IF NOT EXISTS city         TEXT,
  ADD COLUMN IF NOT EXISTS postal_code  TEXT,
  ADD COLUMN IF NOT EXISTS tax_id       TEXT,
  ADD COLUMN IF NOT EXISTS bank_details JSONB DEFAULT '{}';

COMMENT ON COLUMN public.expense_entities.email       IS 'Contact email for the entity';
COMMENT ON COLUMN public.expense_entities.phone       IS 'Contact phone number';
COMMENT ON COLUMN public.expense_entities.address     IS 'Street address (legal)';
COMMENT ON COLUMN public.expense_entities.city        IS 'City (legal)';
COMMENT ON COLUMN public.expense_entities.postal_code IS 'Postal / ZIP code';
COMMENT ON COLUMN public.expense_entities.tax_id      IS 'Tax identification (RCCM, NIF, VAT, etc.)';
COMMENT ON COLUMN public.expense_entities.bank_details IS 'Banking details as JSONB (iban, swift, account_name, …)';

-- ── 2. ADD billing_recipient to dev_expenses ─────────────────────────────────

ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS billing_recipient_entity_id   UUID REFERENCES public.expense_entities(id),
  ADD COLUMN IF NOT EXISTS billing_recipient_snapshot    JSONB,
  ADD COLUMN IF NOT EXISTS billing_recipient_reviewed    BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dev_expenses.billing_recipient_entity_id IS 'Entity that receives the invoice (destinataire de facturation)';
COMMENT ON COLUMN public.dev_expenses.billing_recipient_snapshot  IS 'Frozen snapshot of the billing recipient entity at creation/update time';
COMMENT ON COLUMN public.dev_expenses.billing_recipient_reviewed  IS 'Whether the billing recipient has been manually verified';

-- Index for filtering by billing recipient
CREATE INDEX IF NOT EXISTS idx_dev_expenses_billing_recipient
  ON public.dev_expenses (billing_recipient_entity_id)
  WHERE billing_recipient_entity_id IS NOT NULL;

-- ── 3. UPDATE compatibility view ─────────────────────────────────────────────

-- DROP + CREATE instead of CREATE OR REPLACE because new columns are inserted
-- in the middle of the SELECT list, which PostgreSQL forbids for OR REPLACE.
DROP VIEW IF EXISTS public.dev_expenses_v4_view;

CREATE VIEW public.dev_expenses_v4_view AS
SELECT
  de.id,
  de.title,
  de.category,
  de.creditor_id,
  c.name                                  AS creditor_name,
  de.project_code,
  de.project_ref,
  de.quote_id,
  de.billing_month,
  de.invoice_number,
  de.invoice_date,
  de.due_date,

  -- Entités
  de.incurred_by_entity_id,
  ee_inc.display_name                     AS incurred_by_entity_name,
  de.initially_paid_by_entity_id,
  ee_pay.display_name                     AS initially_paid_by_entity_name,
  de.covered_by_entity_id,
  ee_cov.display_name                     AS covered_by_entity_name,
  de.reimbursement_recipient_entity_id,
  ee_reimb.display_name                   AS reimbursement_recipient_entity_name,

  -- Destinataire de facturation
  de.billing_recipient_entity_id,
  ee_br.display_name                      AS billing_recipient_entity_name,
  de.billing_recipient_snapshot,
  de.billing_recipient_reviewed,

  -- Montants
  de.amount_usd,
  de.invoice_amount,
  de.invoice_currency,
  de.requested_amount,
  de.approved_amount,
  de.settled_amount,

  -- Montant restant théorique (opérationnel, pas comptable)
  GREATEST(
    COALESCE(de.approved_amount, de.requested_amount, de.invoice_amount, 0)
    - COALESCE(de.settled_amount, 0),
    0
  )                                       AS remaining_amount,

  -- Statuts
  de.status                               AS legacy_status_col,
  de.status_v4,
  de.initial_payment_status,
  de.initial_payment_method,

  -- Migration
  de.migration_review_required,
  de.migration_notes,
  de.legacy_status,
  de.legacy_funded_by,
  de.legacy_paid_by,

  -- Archivage
  de.archived,
  de.archived_at,

  -- Dates
  de.submitted_at,
  de.review_started_at,
  de.approved_at,
  de.payment_scheduled_at,
  de.completed_at,
  de.cancelled_at,
  de.paid_at,

  -- Échéance dépassée (indicateur dynamique)
  (
    de.due_date IS NOT NULL
    AND de.due_date < CURRENT_DATE
    AND de.status_v4 NOT IN ('completed','cancelled','archived')
  )::boolean                              AS is_overdue_v4,

  de.created_at,
  de.updated_at

FROM public.dev_expenses de
LEFT JOIN public.creditors c ON c.id = de.creditor_id
LEFT JOIN public.expense_entities ee_inc   ON ee_inc.id   = de.incurred_by_entity_id
LEFT JOIN public.expense_entities ee_pay   ON ee_pay.id   = de.initially_paid_by_entity_id
LEFT JOIN public.expense_entities ee_cov   ON ee_cov.id   = de.covered_by_entity_id
LEFT JOIN public.expense_entities ee_reimb ON ee_reimb.id = de.reimbursement_recipient_entity_id
LEFT JOIN public.expense_entities ee_br    ON ee_br.id    = de.billing_recipient_entity_id;

COMMENT ON VIEW public.dev_expenses_v4_view IS
  'V4 compatibility view: dev_expenses enriched with entity names, '
  'billing recipient + snapshot, remaining_amount (operational, not accounting), '
  'migration review flag, and V4 overdue indicator.';

-- ── 4. RELOAD SCHEMA ─────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
