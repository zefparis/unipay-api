-- ============================================================
-- Settlement RPCs: process_merchant_settlement, approve_settlement, reject_settlement
-- ============================================================

-- ── process_merchant_settlement ───────────────────────────────
-- Atomically:
--   1. Lock the merchant row (FOR UPDATE)
--   2. Compute available balance (credits - settlements)
--   3. Validate amount <= balance
--   4. Insert settlement ledger entry (debit)
--   5. Insert settlement request row
--   6. Return the request + whether auto-payout is allowed
--
-- Idempotence: p_idempotency_key is UNIQUE in merchant_settlement_requests.
-- If the same key is used twice, the second call returns the original request.
CREATE OR REPLACE FUNCTION public.process_merchant_settlement(
  p_merchant_id UUID,
  p_amount NUMERIC,
  p_phone TEXT,
  p_idempotency_key TEXT,
  p_auto_max_per_request NUMERIC,
  p_auto_max_daily NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merchant public.merchants%ROWTYPE;
  v_balance NUMERIC := 0;
  v_today_settled NUMERIC := 0;
  v_new_balance NUMERIC := 0;
  v_ledger_entry_id UUID;
  v_request_id UUID;
  v_status TEXT;
  v_existing_id UUID;
BEGIN
  -- Idempotence: check if this key already exists
  SELECT id INTO v_existing_id
  FROM public.merchant_settlement_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'idempotent', true,
      'request_id', v_existing_id
    );
  END IF;

  -- Lock merchant row
  SELECT * INTO v_merchant
  FROM public.merchants
  WHERE id = p_merchant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MERCHANT_NOT_FOUND';
  END IF;

  -- Compute available balance
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = p_merchant_id;

  -- Default amount = full balance if p_amount is NULL or 0
  IF p_amount IS NULL OR p_amount = 0 THEN
    p_amount := v_balance;
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: available %, requested %', v_balance, p_amount;
  END IF;

  -- Compute today's settled amount (settlements created today)
  SELECT COALESCE(SUM(amount), 0)
  INTO v_today_settled
  FROM public.merchant_settlement_requests
  WHERE merchant_id = p_merchant_id
    AND status IN ('pending_admin_review', 'processing', 'success')
    AND created_at >= date_trunc('day', now());

  -- Determine status: auto-payout or admin review
  IF p_amount > p_auto_max_per_request
     OR (v_today_settled + p_amount) > p_auto_max_daily THEN
    v_status := 'pending_admin_review';
  ELSE
    v_status := 'processing';
  END IF;

  -- Insert ledger entry (settlement = debit)
  v_new_balance := v_balance - p_amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after
  ) VALUES (
    p_merchant_id, NULL, 'settlement', p_amount, v_new_balance
  )
  RETURNING id INTO v_ledger_entry_id;

  -- Insert settlement request
  INSERT INTO public.merchant_settlement_requests (
    merchant_id, amount, phone, status, ledger_entry_id, idempotency_key
  ) VALUES (
    p_merchant_id, p_amount, p_phone, v_status, v_ledger_entry_id, p_idempotency_key
  )
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object(
    'idempotent', false,
    'request_id', v_request_id,
    'amount', p_amount,
    'status', v_status,
    'auto_payout', v_status = 'processing',
    'ledger_entry_id', v_ledger_entry_id,
    'balance_after', v_new_balance
  );
END;
$$;

-- ── reject_settlement ─────────────────────────────────────────
-- Atomically:
--   1. Lock the settlement request
--   2. Verify status is 'pending_admin_review' or 'processing' (not terminal)
--   3. Mark as 'rejected'
--   4. Insert a compensating 'credit' ledger entry to re-credit the merchant
CREATE OR REPLACE FUNCTION public.reject_settlement(
  p_request_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.merchant_settlement_requests%ROWTYPE;
  v_balance NUMERIC := 0;
  v_new_balance NUMERIC := 0;
BEGIN
  SELECT * INTO v_req
  FROM public.merchant_settlement_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  IF v_req.status IN ('success', 'failed', 'rejected') THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_TERMINAL: %', v_req.status;
  END IF;

  -- Re-credit the ledger
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = v_req.merchant_id;

  v_new_balance := v_balance + v_req.amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after
  ) VALUES (
    v_req.merchant_id, NULL, 'credit', v_req.amount, v_new_balance
  );

  -- Mark request as rejected
  UPDATE public.merchant_settlement_requests
  SET status = 'rejected',
      reject_reason = p_reason,
      updated_at = now()
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'rejected', true,
    'request_id', p_request_id,
    'recredited', v_req.amount,
    'balance_after', v_new_balance
  );
END;
$$;

-- ── mark_settlement_success ───────────────────────────────────
-- Called after a successful B2C payout (either auto or admin-approved).
-- Updates the settlement request status and stores the provider_ref.
CREATE OR REPLACE FUNCTION public.mark_settlement_success(
  p_request_id UUID,
  p_provider_ref TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.merchant_settlement_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req
  FROM public.merchant_settlement_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  IF v_req.status = 'success' THEN
    RETURN jsonb_build_object('already_success', true);
  END IF;

  IF v_req.status IN ('rejected', 'failed') THEN
    RAISE EXCEPTION 'SETTLEMENT_IS_%_CANNOT_MARK_SUCCESS', v_req.status;
  END IF;

  UPDATE public.merchant_settlement_requests
  SET status = 'success',
      provider_ref = p_provider_ref,
      updated_at = now()
  WHERE id = p_request_id;

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id);
END;
$$;

-- ── mark_settlement_failed ────────────────────────────────────
-- Called after a failed B2C payout. Re-credits the ledger (like reject).
CREATE OR REPLACE FUNCTION public.mark_settlement_failed(
  p_request_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.merchant_settlement_requests%ROWTYPE;
  v_balance NUMERIC := 0;
  v_new_balance NUMERIC := 0;
BEGIN
  SELECT * INTO v_req
  FROM public.merchant_settlement_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
  END IF;

  IF v_req.status IN ('success', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_TERMINAL: %', v_req.status;
  END IF;

  -- Re-credit the ledger
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = v_req.merchant_id;

  v_new_balance := v_balance + v_req.amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after
  ) VALUES (
    v_req.merchant_id, NULL, 'credit', v_req.amount, v_new_balance
  );

  UPDATE public.merchant_settlement_requests
  SET status = 'failed',
      reject_reason = p_reason,
      updated_at = now()
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'failed', true,
    'request_id', p_request_id,
    'recredited', v_req.amount,
    'balance_after', v_new_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_merchant_settlement TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_settlement TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_settlement_success TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_settlement_failed TO service_role;
