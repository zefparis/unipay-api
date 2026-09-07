-- ============================================================
-- Multi-currency support for merchant ledger + settlement
-- ============================================================
-- Adds currency tracking to merchant_ledger_entries and
-- merchant_settlement_requests so CDF and USD balances are
-- tracked separately (never mixed).
--
-- Prerequisite: no existing merchant transactions with currency
-- NOT IN ('CDF', 'USDT') — verified before running.
-- All existing ledger entries are backfilled to 'CDF' (safe because
-- the merchant system was CDF-only until now).

-- ── 1. Add currency to merchant_ledger_entries ─────────────────
ALTER TABLE public.merchant_ledger_entries
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF';

-- Backfill existing rows (all CDF — verified before migration)
UPDATE public.merchant_ledger_entries
SET currency = 'CDF'
WHERE currency IS NULL OR currency = '';

-- CHECK constraint: only allowed currencies
ALTER TABLE public.merchant_ledger_entries
  DROP CONSTRAINT IF EXISTS merchant_ledger_currency_check;
ALTER TABLE public.merchant_ledger_entries
  ADD CONSTRAINT merchant_ledger_currency_check
  CHECK (currency IN ('CDF', 'USD', 'USDT'));

-- Index for per-currency balance queries
CREATE INDEX IF NOT EXISTS idx_merchant_ledger_currency
  ON public.merchant_ledger_entries (merchant_id, currency, created_at);

-- ── 2. Add currency to merchant_settlement_requests ────────────
ALTER TABLE public.merchant_settlement_requests
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CDF';

ALTER TABLE public.merchant_settlement_requests
  DROP CONSTRAINT IF EXISTS merchant_settlement_currency_check;
ALTER TABLE public.merchant_settlement_requests
  ADD CONSTRAINT merchant_settlement_currency_check
  CHECK (currency IN ('CDF', 'USD', 'USDT'));

CREATE INDEX IF NOT EXISTS idx_settlement_requests_currency
  ON public.merchant_settlement_requests (merchant_id, currency, created_at);

-- ── 3. CHECK constraint on transactions.currency ───────────────
-- The wallet flow already uses CDF, USD, and USDT. We add a CHECK
-- to prevent any arbitrary 3-char string from being stored.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_currency_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_currency_check
  CHECK (currency IN ('CDF', 'USD', 'USDT'));

-- ── 4. process_merchant_settlement — add p_currency param ──────
-- Now filters balance by currency and stores currency on the
-- settlement request + ledger entry.
CREATE OR REPLACE FUNCTION public.process_merchant_settlement(
  p_merchant_id UUID,
  p_amount NUMERIC,
  p_phone TEXT,
  p_idempotency_key TEXT,
  p_auto_max_per_request NUMERIC,
  p_auto_max_daily NUMERIC,
  p_currency TEXT DEFAULT 'CDF'
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
  v_currency TEXT := upper(p_currency);
BEGIN
  IF v_currency NOT IN ('CDF', 'USD', 'USDT') THEN
    RAISE EXCEPTION 'UNSUPPORTED_CURRENCY: %', p_currency;
  END IF;

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

  -- Compute available balance FOR THIS CURRENCY ONLY
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = p_merchant_id
    AND currency = v_currency;

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

  -- Compute today's settled amount (same currency only)
  SELECT COALESCE(SUM(amount), 0)
  INTO v_today_settled
  FROM public.merchant_settlement_requests
  WHERE merchant_id = p_merchant_id
    AND currency = v_currency
    AND status IN ('pending_admin_review', 'processing', 'success')
    AND created_at >= date_trunc('day', now());

  -- Determine status: auto-payout or admin review
  IF p_amount > p_auto_max_per_request
     OR (v_today_settled + p_amount) > p_auto_max_daily THEN
    v_status := 'pending_admin_review';
  ELSE
    v_status := 'processing';
  END IF;

  -- Insert ledger entry (settlement = debit) with currency
  v_new_balance := v_balance - p_amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    p_merchant_id, NULL, 'settlement', p_amount, v_new_balance, v_currency
  )
  RETURNING id INTO v_ledger_entry_id;

  -- Insert settlement request with currency
  INSERT INTO public.merchant_settlement_requests (
    merchant_id, amount, phone, status, ledger_entry_id, idempotency_key, currency
  ) VALUES (
    p_merchant_id, p_amount, p_phone, v_status, v_ledger_entry_id, p_idempotency_key, v_currency
  )
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object(
    'idempotent', false,
    'request_id', v_request_id,
    'amount', p_amount,
    'currency', v_currency,
    'status', v_status,
    'auto_payout', v_status = 'processing',
    'ledger_entry_id', v_ledger_entry_id,
    'balance_after', v_new_balance
  );
END;
$$;

-- ── 5. reject_settlement — re-credit in the correct currency ───
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

  -- Re-credit the ledger IN THE SAME CURRENCY as the settlement
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = v_req.merchant_id
    AND currency = v_req.currency;

  v_new_balance := v_balance + v_req.amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    v_req.merchant_id, NULL, 'credit', v_req.amount, v_new_balance, v_req.currency
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
    'currency', v_req.currency,
    'balance_after', v_new_balance
  );
END;
$$;

-- ── 6. mark_settlement_failed — re-credit in correct currency ──
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

  -- Re-credit the ledger IN THE SAME CURRENCY
  SELECT COALESCE(SUM(
    CASE WHEN type = 'credit' THEN amount ELSE -amount END
  ), 0)
  INTO v_balance
  FROM public.merchant_ledger_entries
  WHERE merchant_id = v_req.merchant_id
    AND currency = v_req.currency;

  v_new_balance := v_balance + v_req.amount;

  INSERT INTO public.merchant_ledger_entries (
    merchant_id, transaction_id, type, amount, balance_after, currency
  ) VALUES (
    v_req.merchant_id, NULL, 'credit', v_req.amount, v_new_balance, v_req.currency
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
    'currency', v_req.currency,
    'balance_after', v_new_balance
  );
END;
$$;

-- mark_settlement_success unchanged (no balance computation needed)
-- but re-grant to be safe
GRANT EXECUTE ON FUNCTION public.process_merchant_settlement TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_settlement TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_settlement_success TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_settlement_failed TO service_role;
