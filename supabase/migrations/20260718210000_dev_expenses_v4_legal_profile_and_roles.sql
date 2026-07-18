-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260718210000_dev_expenses_v4_legal_profile_and_roles.sql
-- Purpose  : 1) Add complete legal profile columns to expense_entities
--            2) Add role capability flags
--            3) Backfill new columns from old ones (only if new are empty)
--            4) Clean existing billing_recipient_snapshots of forbidden keys
--            5) Update view for new columns
-- Self-sufficient: also ensures columns from 20260718200000 exist (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. ENSURE preceding migration columns exist (idempotent) ─────────────────

ALTER TABLE public.expense_entities
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS phone        TEXT,
  ADD COLUMN IF NOT EXISTS address      TEXT,
  ADD COLUMN IF NOT EXISTS city         TEXT,
  ADD COLUMN IF NOT EXISTS postal_code  TEXT,
  ADD COLUMN IF NOT EXISTS tax_id       TEXT,
  ADD COLUMN IF NOT EXISTS bank_details JSONB DEFAULT '{}';

ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS billing_recipient_entity_id   UUID REFERENCES public.expense_entities(id),
  ADD COLUMN IF NOT EXISTS billing_recipient_snapshot    JSONB,
  ADD COLUMN IF NOT EXISTS billing_recipient_reviewed    BOOLEAN NOT NULL DEFAULT false;

-- ── 1. ADD legal profile columns ─────────────────────────────────────────────

ALTER TABLE public.expense_entities
  ADD COLUMN IF NOT EXISTS trade_name           TEXT,
  ADD COLUMN IF NOT EXISTS registration_number  TEXT,
  ADD COLUMN IF NOT EXISTS vat_number           TEXT,
  ADD COLUMN IF NOT EXISTS address_line_1       TEXT,
  ADD COLUMN IF NOT EXISTS address_line_2       TEXT,
  ADD COLUMN IF NOT EXISTS region               TEXT,
  ADD COLUMN IF NOT EXISTS contact_name         TEXT,
  ADD COLUMN IF NOT EXISTS billing_email        TEXT,
  ADD COLUMN IF NOT EXISTS contact_email        TEXT,
  ADD COLUMN IF NOT EXISTS website              TEXT,
  ADD COLUMN IF NOT EXISTS legal_notes          TEXT;

COMMENT ON COLUMN public.expense_entities.trade_name          IS 'Trade name / commercial name (nom commercial)';
COMMENT ON COLUMN public.expense_entities.registration_number IS 'Company registration number (RCCM, etc.)';
COMMENT ON COLUMN public.expense_entities.vat_number          IS 'VAT identification number';
COMMENT ON COLUMN public.expense_entities.address_line_1      IS 'Primary address line (street, number)';
COMMENT ON COLUMN public.expense_entities.address_line_2      IS 'Secondary address line (building, suite)';
COMMENT ON COLUMN public.expense_entities.region              IS 'Region / province / state';
COMMENT ON COLUMN public.expense_entities.contact_name        IS 'Primary contact person name';
COMMENT ON COLUMN public.expense_entities.billing_email       IS 'Email address for billing/invoicing';
COMMENT ON COLUMN public.expense_entities.contact_email       IS 'General contact email';
COMMENT ON COLUMN public.expense_entities.website             IS 'Website URL';
COMMENT ON COLUMN public.expense_entities.legal_notes         IS 'Internal legal notes (never included in snapshots)';

-- ── 2. ADD role capability flags ─────────────────────────────────────────────

ALTER TABLE public.expense_entities
  ADD COLUMN IF NOT EXISTS can_incur_expenses          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_receive_invoices         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_pay_expenses             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_cover_expenses           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_receive_reimbursements   BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.expense_entities.can_incur_expenses          IS 'Whether this entity can be selected as incurred_by (entity that incurs the expense)';
COMMENT ON COLUMN public.expense_entities.can_receive_invoices       IS 'Whether this entity can be selected as a billing recipient';
COMMENT ON COLUMN public.expense_entities.can_pay_expenses           IS 'Whether this entity can be selected as initial payer';
COMMENT ON COLUMN public.expense_entities.can_cover_expenses         IS 'Whether this entity can be selected as covering entity';
COMMENT ON COLUMN public.expense_entities.can_receive_reimbursements IS 'Whether this entity can be selected as reimbursement recipient';

-- ── 3. BACKFILL new columns from old ones (only if new are NULL/empty) ──────
--    Never overwrite a value already set.
--    Uses dynamic SQL to handle cases where source columns (address, email)
--    may not exist yet if the preceding migration hasn't been applied.

UPDATE public.expense_entities
  SET legal_name = display_name
  WHERE legal_name IS NULL
    AND display_name IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'expense_entities'
      AND column_name = 'address'
  ) THEN
    EXECUTE 'UPDATE public.expense_entities
               SET address_line_1 = address
               WHERE address_line_1 IS NULL
                 AND address IS NOT NULL';
    RAISE NOTICE 'Backfilled address_line_1 from address';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'expense_entities'
      AND column_name = 'email'
  ) THEN
    EXECUTE 'UPDATE public.expense_entities
               SET billing_email = email
               WHERE billing_email IS NULL
                 AND email IS NOT NULL';
    RAISE NOTICE 'Backfilled billing_email from email';
  END IF;
END $$;

-- ── 4. CLEAN existing snapshots of forbidden keys ───────────────────────────
--    Removes: bank_details, metadata, legal_notes, payment_details, credentials
--    from billing_recipient_snapshot JSONB.
--    Idempotent: uses #- operator which is a no-op if keys don't exist.
--    Logs the count of cleaned rows via RAISE NOTICE.

DO $$
DECLARE
  cleaned_count INTEGER;
BEGIN
  UPDATE public.dev_expenses
    SET billing_recipient_snapshot = billing_recipient_snapshot
      - 'bank_details'
      - 'metadata'
      - 'legal_notes'
      - 'payment_details'
      - 'credentials'
      - 'notes'
    WHERE billing_recipient_snapshot IS NOT NULL;

  GET DIAGNOSTICS cleaned_count = ROW_COUNT;
  RAISE NOTICE 'Snapshots cleaned: % row(s)', cleaned_count;
END $$;

-- ── 5. UPDATE compatibility view with new entity columns ────────────────────

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
  ee_br.country_code                      AS billing_recipient_country_code,
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
  'billing recipient + country + snapshot, remaining_amount (operational, not accounting), '
  'migration review flag, and V4 overdue indicator.';

-- ── 6. RELOAD SCHEMA ─────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
