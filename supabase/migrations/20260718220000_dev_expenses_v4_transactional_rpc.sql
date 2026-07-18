-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260718220000_dev_expenses_v4_transactional_rpc.sql
-- Purpose  : Transactional RPCs for financial mutations + audit atomicity.
--            Ensures mutation + audit succeed together or rollback together.
--            Includes settlement confirmation with row-level locking.
--            All functions use SECURITY DEFINER with SET search_path = public.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. RPC: transition_expense ─────────────────────────────────────────────
--    Atomically: lock row, check expected status, update expense fields,
--    insert audit event. Raises STATUS_CONFLICT if current status mismatches.

CREATE OR REPLACE FUNCTION public.transition_expense(
  p_expense_id             UUID,
  p_new_status             TEXT,
  p_expected_current_status TEXT DEFAULT NULL,
  p_submitted_at           TIMESTAMPTZ DEFAULT NULL,
  p_review_started_at      TIMESTAMPTZ DEFAULT NULL,
  p_approved_at            TIMESTAMPTZ DEFAULT NULL,
  p_payment_scheduled_at   TIMESTAMPTZ DEFAULT NULL,
  p_completed_at           TIMESTAMPTZ DEFAULT NULL,
  p_cancelled_at           TIMESTAMPTZ DEFAULT NULL,
  p_archived_at            TIMESTAMPTZ DEFAULT NULL,
  p_archived               BOOLEAN DEFAULT NULL,
  p_approved_amount        NUMERIC(14,2) DEFAULT NULL,
  p_rejection_reason       TEXT DEFAULT NULL,
  p_dispute_reason         TEXT DEFAULT NULL,
  p_internal_notes_v4      TEXT DEFAULT NULL,
  p_actor_type             TEXT DEFAULT 'admin',
  p_actor_id               TEXT DEFAULT NULL,
  p_actor_name             TEXT DEFAULT NULL,
  p_metadata               JSONB DEFAULT '{}'::jsonb
) RETURNS public.dev_expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.dev_expenses;
  v_current_status TEXT;
BEGIN
  -- Lock the row and read current status
  SELECT status_v4 INTO v_current_status
    FROM public.dev_expenses
    WHERE id = p_expense_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id;
  END IF;

  -- Concurrency check: if expected status provided, must match
  IF p_expected_current_status IS NOT NULL
     AND v_current_status != p_expected_current_status THEN
    RAISE EXCEPTION 'STATUS_CONFLICT: expected %, got %',
      p_expected_current_status, v_current_status;
  END IF;

  -- Update expense with status + all provided fields
  UPDATE public.dev_expenses
    SET
      status_v4           = p_new_status,
      updated_at          = now(),
      submitted_at        = COALESCE(p_submitted_at, submitted_at),
      review_started_at   = COALESCE(p_review_started_at, review_started_at),
      approved_at         = COALESCE(p_approved_at, approved_at),
      payment_scheduled_at = COALESCE(p_payment_scheduled_at, payment_scheduled_at),
      completed_at        = COALESCE(p_completed_at, completed_at),
      cancelled_at        = COALESCE(p_cancelled_at, cancelled_at),
      archived_at         = COALESCE(p_archived_at, archived_at),
      archived            = COALESCE(p_archived, archived),
      approved_amount     = COALESCE(p_approved_amount, approved_amount),
      rejection_reason    = COALESCE(p_rejection_reason, rejection_reason),
      dispute_reason      = COALESCE(p_dispute_reason, dispute_reason),
      internal_notes_v4   = COALESCE(p_internal_notes_v4, internal_notes_v4)
    WHERE id = p_expense_id
    RETURNING * INTO result;

  -- Insert audit event in the same transaction
  INSERT INTO public.dev_expense_audit_events (
    expense_id, event_type, previous_status, new_status,
    actor_type, actor_id, actor_name, metadata
  ) VALUES (
    p_expense_id, 'status_transition', v_current_status, p_new_status,
    p_actor_type, p_actor_id, p_actor_name, p_metadata
  );

  RETURN result;
END;
$$;

-- ── 2. RPC: confirm_settlement ─────────────────────────────────────────────
--    Atomically: lock settlement, verify status, mark completed,
--    recalculate settled_amount, auto-transition expense, insert audit.

CREATE OR REPLACE FUNCTION public.confirm_settlement(
  p_settlement_id UUID,
  p_actor_type    TEXT DEFAULT 'admin',
  p_actor_id      TEXT DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL
) RETURNS TABLE(
  settlement public.dev_expense_settlements,
  expense    public.dev_expenses,
  new_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settlement public.dev_expense_settlements%ROWTYPE;
  v_expense_id UUID;
  v_prev_status TEXT;
  v_new_settled NUMERIC(14,2);
  v_expected    NUMERIC(14,2);
  v_new_status  TEXT;
  v_expense     public.dev_expenses%ROWTYPE;
BEGIN
  -- Lock the settlement row (FOR UPDATE) to prevent concurrent confirmation
  SELECT * INTO v_settlement
    FROM public.dev_expense_settlements
    WHERE id = p_settlement_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement % not found', p_settlement_id;
  END IF;

  -- Check current status — must not already be completed
  IF v_settlement.status = 'completed' THEN
    -- Idempotent: return current state without changes
    SELECT * INTO v_expense
      FROM public.dev_expenses
      WHERE id = v_settlement.expense_id;

    RETURN QUERY SELECT v_settlement, v_expense, v_expense.status_v4;
    RETURN;
  END IF;

  IF v_settlement.status = 'cancelled' OR v_settlement.status = 'failed' THEN
    RAISE EXCEPTION 'Cannot confirm a % settlement', v_settlement.status;
  END IF;

  v_expense_id := v_settlement.expense_id;

  -- Lock the expense row
  SELECT * INTO v_expense
    FROM public.dev_expenses
    WHERE id = v_expense_id
    FOR UPDATE;

  v_prev_status := v_expense.status_v4;

  -- Mark settlement as completed
  UPDATE public.dev_expense_settlements
    SET status = 'completed',
        confirmed_at = now(),
        updated_at = now()
    WHERE id = p_settlement_id
    RETURNING * INTO v_settlement;

  -- Recalculate settled_amount from all completed settlements
  SELECT COALESCE(SUM(amount), 0) INTO v_new_settled
    FROM public.dev_expense_settlements
    WHERE expense_id = v_expense_id
      AND status = 'completed';

  -- Update expense settled_amount
  UPDATE public.dev_expenses
    SET settled_amount = v_new_settled,
        updated_at = now()
    WHERE id = v_expense_id
    RETURNING * INTO v_expense;

  -- Determine expected amount for auto-transition
  v_expected := COALESCE(v_expense.approved_amount, v_expense.requested_amount, v_expense.invoice_amount, 0);

  -- Auto-transition logic
  v_new_status := v_expense.status_v4;
  IF v_expense.status_v4 = 'payment_scheduled' AND v_new_settled > 0 AND v_new_settled < v_expected THEN
    v_new_status := 'partially_paid';
    UPDATE public.dev_expenses
      SET status_v4 = 'partially_paid', updated_at = now()
      WHERE id = v_expense_id
      RETURNING * INTO v_expense;
  ELSIF (v_expense.status_v4 = 'payment_scheduled' OR v_expense.status_v4 = 'partially_paid')
        AND v_new_settled >= v_expected AND v_expected > 0 THEN
    v_new_status := 'completed';
    UPDATE public.dev_expenses
      SET status_v4 = 'completed', completed_at = now(), updated_at = now()
      WHERE id = v_expense_id
      RETURNING * INTO v_expense;
  END IF;

  -- Audit: settlement confirmed
  INSERT INTO public.dev_expense_audit_events (
    expense_id, event_type, previous_status, new_status,
    actor_type, actor_id, actor_name, metadata
  ) VALUES (
    v_expense_id, 'settlement_confirmed', v_prev_status, v_new_status,
    p_actor_type, p_actor_id, p_actor_name,
    jsonb_build_object(
      'settlement_id', p_settlement_id,
      'settled_amount', v_new_settled,
      'auto_transition', (v_new_status != v_prev_status)
    )
  );

  -- If auto-transitioned, add a second audit event
  IF v_new_status != v_prev_status THEN
    INSERT INTO public.dev_expense_audit_events (
      expense_id, event_type, previous_status, new_status,
      actor_type, actor_id, actor_name, metadata
    ) VALUES (
      v_expense_id, 'auto_status_transition', v_prev_status, v_new_status,
      'system', NULL, NULL,
      jsonb_build_object('trigger', 'settlement_confirmation', 'settled_amount', v_new_settled)
    );
  END IF;

  RETURN QUERY SELECT v_settlement, v_expense, v_new_status;
END;
$$;

-- ── 3. RPC: create_settlement_with_audit ───────────────────────────────────
--    Atomically: create settlement + insert audit event.

CREATE OR REPLACE FUNCTION public.create_settlement_with_audit(
  p_expense_id    UUID,
  p_settlement_type TEXT,
  p_payer_entity_id UUID DEFAULT NULL,
  p_recipient_entity_id UUID DEFAULT NULL,
  p_amount        NUMERIC(14,2),
  p_currency      TEXT DEFAULT 'USD',
  p_payment_method TEXT DEFAULT NULL,
  p_transaction_reference TEXT DEFAULT NULL,
  p_scheduled_at  TIMESTAMPTZ DEFAULT NULL,
  p_notes         TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_actor_type    TEXT DEFAULT 'admin',
  p_actor_id      TEXT DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL,
  p_expense_status TEXT DEFAULT NULL
) RETURNS public.dev_expense_settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.dev_expense_settlements;
  existing_rec public.dev_expense_settlements%ROWTYPE;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO existing_rec
      FROM public.dev_expense_settlements
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;

    IF FOUND THEN
      IF existing_rec.expense_id = p_expense_id
         AND existing_rec.settlement_type = p_settlement_type
         AND existing_rec.amount = p_amount THEN
        RETURN existing_rec;
      END IF;
      RAISE EXCEPTION 'Idempotency key conflict: same key with different payload';
    END IF;
  END IF;

  -- Insert settlement
  INSERT INTO public.dev_expense_settlements (
    expense_id, settlement_type, payer_entity_id, recipient_entity_id,
    amount, currency, payment_method, transaction_reference,
    status, scheduled_at, notes, idempotency_key
  ) VALUES (
    p_expense_id, p_settlement_type, p_payer_entity_id, p_recipient_entity_id,
    p_amount, p_currency, p_payment_method, p_transaction_reference,
    'scheduled', p_scheduled_at, p_notes, p_idempotency_key
  )
  RETURNING * INTO result;

  -- Insert audit in same transaction
  INSERT INTO public.dev_expense_audit_events (
    expense_id, event_type, previous_status, new_status,
    actor_type, actor_id, actor_name, metadata
  ) VALUES (
    p_expense_id, 'settlement_created', p_expense_status, p_expense_status,
    p_actor_type, p_actor_id, p_actor_name,
    jsonb_build_object(
      'settlement_id', result.id,
      'settlement_type', p_settlement_type,
      'amount', p_amount,
      'currency', p_currency
    )
  );

  RETURN result;
END;
$$;

-- ── 4. RPC: resolve_migration_review_with_audit ────────────────────────────
--    Atomically: lock expense, check migration_review_required,
--    apply field updates, generate snapshot if billing_recipient_entity_id provided,
--    set migration_review_required=false, billing_recipient_reviewed=true,
--    insert audit event.
--    Idempotent: if already resolved (migration_review_required=false),
--    returns current state without changes.

CREATE OR REPLACE FUNCTION public.resolve_migration_review_with_audit(
  p_expense_id                     UUID,
  p_status                         TEXT DEFAULT NULL,
  p_incurred_by_entity_id          UUID DEFAULT NULL,
  p_initially_paid_by_entity_id    UUID DEFAULT NULL,
  p_covered_by_entity_id           UUID DEFAULT NULL,
  p_reimbursement_recipient_entity_id UUID DEFAULT NULL,
  p_billing_recipient_entity_id    UUID DEFAULT NULL,
  p_approved_amount                NUMERIC(14,2) DEFAULT NULL,
  p_settled_amount                 NUMERIC(14,2) DEFAULT NULL,
  p_migration_notes                TEXT DEFAULT NULL,
  p_actor_type                     TEXT DEFAULT 'admin',
  p_actor_id                       TEXT DEFAULT NULL,
  p_actor_name                     TEXT DEFAULT NULL
) RETURNS public.dev_expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.dev_expenses;
  v_current public.dev_expenses%ROWTYPE;
  v_snapshot JSONB := NULL;
  v_entity public.expense_entities%ROWTYPE;
BEGIN
  -- Lock the expense row
  SELECT * INTO v_current
    FROM public.dev_expenses
    WHERE id = p_expense_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id;
  END IF;

  -- Idempotency: if already resolved, return current state
  IF v_current.migration_review_required = false THEN
    RAISE EXCEPTION 'MIGRATION_REVIEW_ALREADY_RESOLVED';
  END IF;

  -- Generate snapshot if billing_recipient_entity_id is provided
  IF p_billing_recipient_entity_id IS NOT NULL THEN
    SELECT * INTO v_entity
      FROM public.expense_entities
      WHERE id = p_billing_recipient_entity_id
      AND active = true
      AND can_receive_invoices = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing recipient entity not found, inactive, or lacks can_receive_invoices';
    END IF;

    -- Build snapshot with explicit allowlist (never includes bank_details)
    v_snapshot := jsonb_build_object(
      'entity_id', v_entity.id,
      'legal_name', v_entity.legal_name,
      'trade_name', v_entity.trade_name,
      'display_name', v_entity.display_name,
      'entity_type', v_entity.entity_type,
      'registration_number', v_entity.registration_number,
      'tax_id', v_entity.tax_id,
      'vat_number', v_entity.vat_number,
      'address_line_1', COALESCE(v_entity.address_line_1, v_entity.address),
      'address_line_2', v_entity.address_line_2,
      'postal_code', v_entity.postal_code,
      'city', v_entity.city,
      'region', v_entity.region,
      'country_code', v_entity.country_code,
      'contact_name', v_entity.contact_name,
      'billing_email', COALESCE(v_entity.billing_email, v_entity.email),
      'phone', v_entity.phone,
      'captured_at', now()
    );
  END IF;

  -- Apply all updates atomically
  UPDATE public.dev_expenses
    SET
      updated_at                      = now(),
      migration_review_required       = false,
      status_v4                       = COALESCE(p_status::public.dev_expense_status_v4, status_v4),
      incurred_by_entity_id           = COALESCE(p_incurred_by_entity_id, incurred_by_entity_id),
      initially_paid_by_entity_id     = COALESCE(p_initially_paid_by_entity_id, initially_paid_by_entity_id),
      covered_by_entity_id            = COALESCE(p_covered_by_entity_id, covered_by_entity_id),
      reimbursement_recipient_entity_id = COALESCE(p_reimbursement_recipient_entity_id, reimbursement_recipient_entity_id),
      billing_recipient_entity_id     = COALESCE(p_billing_recipient_entity_id, billing_recipient_entity_id),
      billing_recipient_snapshot      = COALESCE(v_snapshot, billing_recipient_snapshot),
      billing_recipient_reviewed      = CASE WHEN p_billing_recipient_entity_id IS NOT NULL THEN true ELSE billing_recipient_reviewed END,
      approved_amount                 = COALESCE(p_approved_amount, approved_amount),
      settled_amount                  = COALESCE(p_settled_amount, settled_amount),
      migration_notes                 = CASE
        WHEN p_migration_notes IS NOT NULL THEN
          COALESCE(migration_notes, '') || E'\n' || p_migration_notes
        ELSE migration_notes
      END
    WHERE id = p_expense_id
    RETURNING * INTO result;

  -- Insert audit event
  INSERT INTO public.dev_expense_audit_events (
    expense_id, event_type, previous_status, new_status,
    actor_type, actor_id, actor_name, metadata
  ) VALUES (
    p_expense_id, 'migration_review_resolved', v_current.status_v4::text, result.status_v4::text,
    p_actor_type, p_actor_id, p_actor_name,
    jsonb_build_object(
      'status', p_status,
      'has_notes', p_migration_notes IS NOT NULL,
      'snapshot_generated', v_snapshot IS NOT NULL
    )
  );

  RETURN result;
END;
$$;

-- ── 5. RPC: refresh_snapshot_with_audit ────────────────────────────────────
--    Atomically: update snapshot + insert audit event.

CREATE OR REPLACE FUNCTION public.refresh_snapshot_with_audit(
  p_expense_id    UUID,
  p_snapshot      JSONB,
  p_previous_status TEXT,
  p_new_status    TEXT,
  p_entity_id     UUID,
  p_actor_type    TEXT DEFAULT 'admin',
  p_actor_id      TEXT DEFAULT NULL,
  p_actor_name    TEXT DEFAULT NULL
) RETURNS public.dev_expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.dev_expenses;
BEGIN
  UPDATE public.dev_expenses
    SET billing_recipient_snapshot = p_snapshot,
        billing_recipient_reviewed = true,
        updated_at = now()
    WHERE id = p_expense_id
    RETURNING * INTO result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id;
  END IF;

  INSERT INTO public.dev_expense_audit_events (
    expense_id, event_type, previous_status, new_status,
    actor_type, actor_id, actor_name, metadata
  ) VALUES (
    p_expense_id, 'billing_recipient_snapshot_refreshed', p_previous_status, p_new_status,
    p_actor_type, p_actor_id, p_actor_name,
    jsonb_build_object('snapshot_entity_id', p_entity_id)
  );

  RETURN result;
END;
$$;

-- ── 6. GRANT execute to service_role ───────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.transition_expense TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_settlement TO service_role;
GRANT EXECUTE ON FUNCTION public.create_settlement_with_audit TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_migration_review_with_audit TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_snapshot_with_audit TO service_role;

-- ── 7. RELOAD SCHEMA ─────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
