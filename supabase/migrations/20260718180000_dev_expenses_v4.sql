-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260718180000_dev_expenses_v4
-- Purpose  : Modèle financier V4 — entités configurables, statuts métier enrichis,
--            règlements séparés, audit immutable, mapping historique prudent.
--
-- Principes:
--   * Migration additive uniquement — aucune colonne existante n'est supprimée.
--   * Aucun remboursement historique déduit automatiquement.
--   * Aucun statut `completed` attribué automatiquement à une ligne legacy `paid`.
--   * Les situations ambiguës sont marquées migration_review_required = true.
--   * Toutes les nouvelles tables utilisent RLS (service_role only).
--   * L'audit est immutable (UPDATE et DELETE interdits par trigger).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. ENUMS ─────────────────────────────────────────────────────────────────

-- 1a. Statut métier V4
DO $$ BEGIN
  CREATE TYPE public.dev_expense_status_v4 AS ENUM (
    'draft',
    'submitted',
    'under_review',
    'approved',
    'partially_approved',
    'rejected',
    'payment_scheduled',
    'partially_paid',
    'completed',
    'disputed',
    'cancelled',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1b. Type de règlement initial
DO $$ BEGIN
  CREATE TYPE public.dev_expense_initial_payment_status AS ENUM (
    'unpaid',
    'paid_by_incurred_entity',
    'paid_by_covering_entity',
    'paid_by_third_party',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. TABLE expense_entities ────────────────────────────────────────────────
-- Entités financières configurables (personnes, sociétés, groupes, projets).
-- Pas d'enum PostgreSQL figé — les entités sont gérées par données.

CREATE TABLE IF NOT EXISTS public.expense_entities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL UNIQUE,
  display_name TEXT        NOT NULL,
  entity_type  TEXT        NOT NULL
    CONSTRAINT expense_entities_type_check
    CHECK (entity_type IN ('person','company','partner_group','project','other')),
  legal_name   TEXT,
  country_code TEXT,
  active       BOOLEAN     NOT NULL DEFAULT true,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.expense_entities IS
  'Configurable financial entities (persons, companies, partner groups, projects). '
  'Stable technical code, editable display_name. Not a fixed enum.';

-- RLS
ALTER TABLE public.expense_entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_entities_service_role_all" ON public.expense_entities;
CREATE POLICY "expense_entities_service_role_all"
  ON public.expense_entities FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_expense_entities_updated_at ON public.expense_entities;
CREATE TRIGGER trg_expense_entities_updated_at
  BEFORE UPDATE ON public.expense_entities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 2a. Seed initial entities (idempotent)
INSERT INTO public.expense_entities (code, display_name, entity_type) VALUES
  ('benjamin_barrere', 'Benjamin Barrere',  'person'),
  ('ia_solution',      'IA Solution',       'company'),
  ('congo_gaming',     'Congo Gaming',      'company'),
  ('unipay_congo',     'UniPay Congo',      'company'),
  ('partner_group',    'Groupe partenaire', 'partner_group'),
  ('other',            'Autre',             'other')
ON CONFLICT (code) DO NOTHING;

-- ── 3. TABLE DE RÉFÉRENCE: payment_methods ───────────────────────────────────
-- Une table de référence est préférée à un enum pour permettre l'ajout de
-- nouveaux moyens de paiement sans migration lourde.

CREATE TABLE IF NOT EXISTS public.payment_methods_ref (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT        NOT NULL UNIQUE,
  display_name TEXT       NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_methods_ref IS
  'Reference table for payment methods. Allows adding new methods without migration.';

ALTER TABLE public.payment_methods_ref ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_methods_ref_service_role_all" ON public.payment_methods_ref;
CREATE POLICY "payment_methods_ref_service_role_all"
  ON public.payment_methods_ref FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO public.payment_methods_ref (code, display_name, sort_order) VALUES
  ('bank_transfer',           'Virement bancaire',     1),
  ('card',                    'Carte bancaire',        2),
  ('usdt',                    'USDT',                  3),
  ('usdc',                    'USDC',                  4),
  ('binance',                 'Binance',               5),
  ('unipay_wallet',           'Portefeuille UniPay',   6),
  ('mobile_money',            'Mobile Money',          7),
  ('direct_supplier_payment', 'Paiement direct fournisseur', 8),
  ('internal_offset',         'Compensation interne',  9),
  ('cash',                    'Espèces',              10),
  ('other',                   'Autre',                11),
  ('unknown',                 'Inconnu',              12)
ON CONFLICT (code) DO NOTHING;

-- ── 4. COLONNES V4 DE dev_expenses ───────────────────────────────────────────

-- 4a. Identification
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS project_code  TEXT NOT NULL DEFAULT 'unipay-congo',
  ADD COLUMN IF NOT EXISTS quote_id      UUID;

-- 4b. Entités (foreign keys vers expense_entities)
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS incurred_by_entity_id            UUID,
  ADD COLUMN IF NOT EXISTS initially_paid_by_entity_id       UUID,
  ADD COLUMN IF NOT EXISTS covered_by_entity_id              UUID,
  ADD COLUMN IF NOT EXISTS reimbursement_recipient_entity_id UUID;

-- Add FK constraints (ON DELETE RESTRICT for financial references)
DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT fk_dev_expenses_incurred_by_entity
    FOREIGN KEY (incurred_by_entity_id) REFERENCES public.expense_entities(id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT fk_dev_expenses_initially_paid_by_entity
    FOREIGN KEY (initially_paid_by_entity_id) REFERENCES public.expense_entities(id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT fk_dev_expenses_covered_by_entity
    FOREIGN KEY (covered_by_entity_id) REFERENCES public.expense_entities(id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT fk_dev_expenses_reimbursement_recipient_entity
    FOREIGN KEY (reimbursement_recipient_entity_id) REFERENCES public.expense_entities(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- FK vers quotes(id) — pas de cycle problématique car quotes.converted_expense_id
-- pointe déjà vers dev_expenses(id) avec ON DELETE SET NULL.
DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT fk_dev_expenses_quote_id
    FOREIGN KEY (quote_id) REFERENCES public.quotes(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4c. Montants
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS invoice_amount    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS invoice_currency  TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS requested_amount  NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS approved_amount   NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS settled_amount    NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Contraintes sur les montants (non négatifs)
DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT dev_expenses_invoice_amount_nonneg
    CHECK (invoice_amount IS NULL OR invoice_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT dev_expenses_requested_amount_nonneg
    CHECK (requested_amount IS NULL OR requested_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT dev_expenses_approved_amount_nonneg
    CHECK (approved_amount IS NULL OR approved_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.dev_expenses
    ADD CONSTRAINT dev_expenses_settled_amount_nonneg
    CHECK (settled_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4d. Paiement initial
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS initial_payment_status   public.dev_expense_initial_payment_status,
  ADD COLUMN IF NOT EXISTS initial_payment_method   TEXT;

-- 4e. Statut V4
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS status_v4   public.dev_expense_status_v4;

-- 4f. Dates métier
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS invoice_date         DATE,
  ADD COLUMN IF NOT EXISTS submitted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ;

-- 4g. Raisons et notes
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS rejection_reason   TEXT,
  ADD COLUMN IF NOT EXISTS dispute_reason     TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes_v4  TEXT;

-- 4h. Migration et compatibilité
ALTER TABLE public.dev_expenses
  ADD COLUMN IF NOT EXISTS migration_review_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS migration_notes            TEXT,
  ADD COLUMN IF NOT EXISTS legacy_status              TEXT,
  ADD COLUMN IF NOT EXISTS legacy_funded_by           TEXT,
  ADD COLUMN IF NOT EXISTS legacy_paid_by             TEXT;

-- ── 5. TABLE dev_expense_settlements ─────────────────────────────────────────
-- Règlements et remboursements: paiements direct au fournisseur,
-- remboursements à une entité, paiements partiels, compensations internes,
-- règlements crypto, corrections.

CREATE TABLE IF NOT EXISTS public.dev_expense_settlements (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  expense_id         UUID         NOT NULL
    REFERENCES public.dev_expenses(id) ON DELETE RESTRICT,

  settlement_type    TEXT         NOT NULL
    CONSTRAINT dev_expense_settlements_type_check
    CHECK (settlement_type IN (
      'supplier_payment',
      'reimbursement',
      'partial_reimbursement',
      'internal_offset',
      'adjustment',
      'other'
    )),

  payer_entity_id    UUID
    REFERENCES public.expense_entities(id) ON DELETE RESTRICT,

  recipient_entity_id UUID
    REFERENCES public.expense_entities(id) ON DELETE RESTRICT,

  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency           TEXT          NOT NULL DEFAULT 'USD',

  payment_method     TEXT,
  transaction_reference TEXT,

  status             TEXT          NOT NULL DEFAULT 'scheduled'
    CONSTRAINT dev_expense_settlements_status_check
    CHECK (status IN ('scheduled','processing','completed','failed','cancelled')),

  scheduled_at       TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  confirmed_at       TIMESTAMPTZ,

  proof_file_url     TEXT,
  notes              TEXT,

  idempotency_key    TEXT          UNIQUE,

  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dev_expense_settlements IS
  'Settlements and reimbursements for dev expenses. '
  'Covers supplier payments, reimbursements, partial payments, internal offsets, adjustments. '
  'No historical settlements are created automatically during migration.';

-- RLS
ALTER TABLE public.dev_expense_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dev_expense_settlements_service_role_all" ON public.dev_expense_settlements;
CREATE POLICY "dev_expense_settlements_service_role_all"
  ON public.dev_expense_settlements FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_dev_expense_settlements_updated_at ON public.dev_expense_settlements;
CREATE TRIGGER trg_dev_expense_settlements_updated_at
  BEFORE UPDATE ON public.dev_expense_settlements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dev_expense_settlements_expense_id
  ON public.dev_expense_settlements (expense_id);

CREATE INDEX IF NOT EXISTS idx_dev_expense_settlements_status
  ON public.dev_expense_settlements (status);

CREATE INDEX IF NOT EXISTS idx_dev_expense_settlements_executed_at
  ON public.dev_expense_settlements (executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dev_expense_settlements_payer_entity_id
  ON public.dev_expense_settlements (payer_entity_id);

CREATE INDEX IF NOT EXISTS idx_dev_expense_settlements_recipient_entity_id
  ON public.dev_expense_settlements (recipient_entity_id);

-- ── 6. TABLE dev_expense_audit_events (IMMUTABLE) ────────────────────────────

CREATE TABLE IF NOT EXISTS public.dev_expense_audit_events (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  expense_id      UUID         NOT NULL
    REFERENCES public.dev_expenses(id) ON DELETE RESTRICT,

  event_type      TEXT         NOT NULL,

  previous_status TEXT,
  new_status      TEXT,

  actor_type      TEXT         NOT NULL DEFAULT 'system'
    CONSTRAINT dev_expense_audit_actor_type_check
    CHECK (actor_type IN ('admin','system','cron','migration','api')),

  actor_id        TEXT,
  actor_name      TEXT,

  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dev_expense_audit_events IS
  'Immutable audit trail for dev expense lifecycle events. '
  'UPDATE and DELETE are blocked by trigger. ON DELETE RESTRICT on expense_id.';

-- RLS
ALTER TABLE public.dev_expense_audit_events ENABLE ROW LEVEL SECURITY;

-- Service role can INSERT and SELECT but NOT UPDATE or DELETE
DROP POLICY IF EXISTS "dev_expense_audit_events_service_role_select" ON public.dev_expense_audit_events;
CREATE POLICY "dev_expense_audit_events_service_role_select"
  ON public.dev_expense_audit_events FOR SELECT TO service_role
  USING (true);

DROP POLICY IF EXISTS "dev_expense_audit_events_service_role_insert" ON public.dev_expense_audit_events;
CREATE POLICY "dev_expense_audit_events_service_role_insert"
  ON public.dev_expense_audit_events FOR INSERT TO service_role
  WITH CHECK (true);

-- Explicitly no UPDATE or DELETE policy for service_role.
-- RLS denies by default when no matching policy exists.

-- 6a. Immutability trigger: block UPDATE and DELETE
CREATE OR REPLACE FUNCTION public.block_audit_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'dev_expense_audit_events is immutable: UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_audit_update ON public.dev_expense_audit_events;
CREATE TRIGGER trg_block_audit_update
  BEFORE UPDATE ON public.dev_expense_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.block_audit_event_modification();

DROP TRIGGER IF EXISTS trg_block_audit_delete ON public.dev_expense_audit_events;
CREATE TRIGGER trg_block_audit_delete
  BEFORE DELETE ON public.dev_expense_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.block_audit_event_modification();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dev_expense_audit_events_expense_created
  ON public.dev_expense_audit_events (expense_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dev_expense_audit_events_event_type
  ON public.dev_expense_audit_events (event_type);

CREATE INDEX IF NOT EXISTS idx_dev_expense_audit_events_created_at
  ON public.dev_expense_audit_events (created_at DESC);

-- ── 7. COLONNES V4 DE quotes ─────────────────────────────────────────────────

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS estimated_amount      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS final_invoice_amount  NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS currency              TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS accepted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at            TIMESTAMPTZ;

-- 7a. Trigger updated_at manquant sur quotes
DROP TRIGGER IF EXISTS trg_quotes_updated_at ON public.quotes;
CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── 8. MAPPING HISTORIQUE PRUDENT ────────────────────────────────────────────
-- Règle absolue: ne jamais déduire qu'une facture est remboursée ou completed
-- uniquement parce que status = 'paid'.

-- 8a. Sauvegarde des valeurs legacy (idempotent — seulement si NULL)
UPDATE public.dev_expenses
SET legacy_status = status
WHERE legacy_status IS NULL;

UPDATE public.dev_expenses
SET legacy_funded_by = funded_by
WHERE legacy_funded_by IS NULL;

UPDATE public.dev_expenses
SET legacy_paid_by = paid_by
WHERE legacy_paid_by IS NULL;

-- 8b. Montants (idempotent — seulement si NULL)
UPDATE public.dev_expenses
SET invoice_amount = amount_usd
WHERE invoice_amount IS NULL;

UPDATE public.dev_expenses
SET invoice_currency = 'USD'
WHERE invoice_currency IS NULL OR invoice_currency = '';

UPDATE public.dev_expenses
SET requested_amount = amount_usd
WHERE requested_amount IS NULL;

-- approved_amount reste NULL quand l'approbation n'est pas prouvée.
-- settled_amount reste à 0 (défaut) quand le règlement réel ne peut pas être prouvé.

-- 8c. Mapping des statuts (idempotent — seulement si status_v4 IS NULL)
UPDATE public.dev_expenses
SET
  status_v4 = 'submitted'::public.dev_expense_status_v4,
  migration_review_required = true,
  migration_notes = COALESCE(migration_notes, '') ||
    'Migrated from legacy pending; approval and payment responsibility require review.'
WHERE status_v4 IS NULL
  AND status = 'pending';

UPDATE public.dev_expenses
SET
  status_v4 = 'payment_scheduled'::public.dev_expense_status_v4,
  migration_review_required = true,
  migration_notes = COALESCE(migration_notes, '') ||
    'Legacy record marked paid, but direct supplier payment versus reimbursement cannot be inferred.'
WHERE status_v4 IS NULL
  AND status = 'paid';

UPDATE public.dev_expenses
SET
  status_v4 = 'archived'::public.dev_expense_status_v4,
  migration_review_required = true,
  migration_notes = COALESCE(migration_notes, '') ||
    'Legacy reconciled status was unused or insufficiently defined; manual review required.'
WHERE status_v4 IS NULL
  AND status = 'reconciled';

-- 8d. Archivage (archived = true)
UPDATE public.dev_expenses
SET
  status_v4 = 'archived'::public.dev_expense_status_v4,
  migration_review_required = true,
  migration_notes = COALESCE(migration_notes, '') ||
    'Legacy archived=true; manual review required.'
WHERE status_v4 IS NULL
  AND archived = true;

-- 8e. Pour toutes les lignes sans statut V4 (cas non couvert ci-dessus)
UPDATE public.dev_expenses
SET
  status_v4 = 'draft'::public.dev_expense_status_v4,
  migration_review_required = true,
  migration_notes = COALESCE(migration_notes, '') ||
    'Legacy status could not be mapped to a specific V4 status; manual review required.'
WHERE status_v4 IS NULL;

-- 8f. Entités historiques
-- funded_by = 'tekkbridge' (défaut) → non mappable sans ambiguïté → other
-- funded_by = 'benoit' → non mappable (Benoît ≠ Benjamin, ne pas mapper)
-- paid_by = 'benoit' (défaut) → non mappable
-- paid_by = 'tekkbridge' → non mappable
-- Toutes les valeurs legacy sont conservées dans les colonnes dédiées.
-- Aucun mapping automatique funded_by → incurred_by_entity_id ou
-- paid_by → initially_paid_by_entity_id n'est appliqué.

-- 8g. Initialisation de initial_payment_status pour les lignes migrées
UPDATE public.dev_expenses
SET initial_payment_status = 'unknown'::public.dev_expense_initial_payment_status
WHERE initial_payment_status IS NULL
  AND status_v4 IS NOT NULL;

-- ── 9. INITIALISATION DES DEVIS ──────────────────────────────────────────────

UPDATE public.quotes
SET estimated_amount = amount_usd
WHERE estimated_amount IS NULL;

UPDATE public.quotes
SET currency = 'USD'
WHERE currency IS NULL OR currency = '';

-- final_invoice_amount n'est pas rempli automatiquement.

-- ── 10. VUE DE COMPATIBILITÉ V4 ──────────────────────────────────────────────

CREATE OR REPLACE VIEW public.dev_expenses_v4_view AS
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
LEFT JOIN public.expense_entities ee_reimb ON ee_reimb.id = de.reimbursement_recipient_entity_id;

COMMENT ON VIEW public.dev_expenses_v4_view IS
  'V4 compatibility view: dev_expenses enriched with entity names, '
  'remaining_amount (operational, not accounting), migration review flag, '
  'and V4 overdue indicator. Does not replace dev_expenses_with_status.';

-- ── 11. INDEX V4 ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_dev_expenses_status_v4
  ON public.dev_expenses (status_v4);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_migration_review
  ON public.dev_expenses (migration_review_required)
  WHERE migration_review_required = true;

CREATE INDEX IF NOT EXISTS idx_dev_expenses_covered_by_entity
  ON public.dev_expenses (covered_by_entity_id);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_incurred_by_entity
  ON public.dev_expenses (incurred_by_entity_id);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_invoice_date
  ON public.dev_expenses (invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_dev_expenses_project_code
  ON public.dev_expenses (project_code);

-- Index partiel: dépenses actives (non terminées/annulées/archivées)
CREATE INDEX IF NOT EXISTS idx_dev_expenses_active_v4
  ON public.dev_expenses (status_v4, due_date)
  WHERE status_v4 NOT IN ('completed','cancelled','archived');

-- ── 12. DOCUMENTATION: PIÈCES JOINTES FUTURES ────────────────────────────────
-- Le modèle actuel utilise des colonnes URL directes:
--   dev_expenses.invoice_url
--   quotes.quote_file_url
--   dev_expense_settlements.proof_file_url
--
-- Le futur modèle devrait distinguer:
--   invoice, quote, payment_proof, reimbursement_proof, supporting_document
--
-- Aucune table de documents n'est créée dans cette task.
-- Aucun fichier Supabase Storage n'est déplacé.
-- Aucune URL existante n'est modifiée.

-- ── 13. REFRESH POSTGREST SCHEMA CACHE ───────────────────────────────────────
NOTIFY pgrst, 'reload schema';
