-- ============================================================
-- Settlement callback fix: link transactions to settlement requests
-- ============================================================
-- Bug: merchant_settlement_requests.status was set to 'success'
-- immediately after initiatePayout(), before the operator callback.
-- If the operator later rejected the payout (e.g. MSISDN2 INCORRECT),
-- the callback updated transactions.status but NOT the settlement
-- request — because the settlement flow never created a transactions
-- row, and there was no FK linking the two tables.
--
-- Fix:
--   1. Add settlement_request_id column to transactions (nullable FK).
--   2. Create mark_settlement_processing() RPC — stores provider_ref
--      and keeps status='processing' (replaces premature mark_settlement_success).
--   3. Extend process_wallet_provider_callback() to also update the
--      linked settlement request when a callback/reconciliation resolves
--      a transaction that has settlement_request_id.
--   4. Add reconcile_attempted_at to merchant_settlement_requests so
--      the reconciliation worker can claim stuck settlements without
--      re-querying already-processed rows.

-- ── 1. settlement_request_id on transactions ──────────────────
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS settlement_request_id uuid
  REFERENCES public.merchant_settlement_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_settlement_request_id
  ON public.transactions (settlement_request_id)
  WHERE settlement_request_id IS NOT NULL;

-- ── 2. reconcile_attempted_at on merchant_settlement_requests ──
-- Allows the reconciliation worker to claim stuck settlements with
-- a cooldown, mirroring the transactions.reconcile_attempted_at column.
ALTER TABLE public.merchant_settlement_requests
  ADD COLUMN IF NOT EXISTS reconcile_attempted_at timestamptz;

-- ── 3. mark_settlement_processing ──────────────────────────────
-- Called after initiatePayout() succeeds (HTTP 200 from Unipesa).
-- Stores the provider_ref so the callback can link back, and keeps
-- the settlement in 'processing' until the callback confirms.
CREATE OR REPLACE FUNCTION public.mark_settlement_processing(
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

  IF v_req.status IN ('success', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_TERMINAL: %', v_req.status;
  END IF;

  UPDATE public.merchant_settlement_requests
  SET status       = 'processing',
      provider_ref = p_provider_ref,
      updated_at   = now()
  WHERE id = p_request_id;

  RETURN jsonb_build_object('processing', true, 'request_id', p_request_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_settlement_processing(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.mark_settlement_processing(UUID, TEXT) FROM PUBLIC;

-- ── 4. claim_pending_settlements ───────────────────────────────
-- Claims settlement requests stuck in 'processing' for reconciliation.
-- Mirrors claim_pending_unipay_transactions: SELECT FOR UPDATE SKIP
-- LOCKED + stamps reconcile_attempted_at.
CREATE OR REPLACE FUNCTION public.claim_pending_settlements(
  p_min_age_seconds INTEGER DEFAULT 300,
  p_max_age_seconds INTEGER DEFAULT 604800,
  p_batch_size INTEGER DEFAULT 50,
  p_retry_after_seconds INTEGER DEFAULT 300
) RETURNS TABLE (
  id uuid,
  merchant_id uuid,
  amount numeric,
  currency text,
  phone text,
  provider_ref text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.merchant_settlement_requests
  SET reconcile_attempted_at = now()
  WHERE id IN (
    SELECT id
    FROM public.merchant_settlement_requests
    WHERE status = 'processing'
      AND created_at <= now() - make_interval(secs => p_min_age_seconds)
      AND created_at >= now() - make_interval(secs => p_max_age_seconds)
      AND (
        reconcile_attempted_at IS NULL
        OR reconcile_attempted_at < now() - make_interval(secs => p_retry_after_seconds)
      )
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    id,
    merchant_id,
    amount,
    currency,
    phone,
    provider_ref,
    created_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_settlements(INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.claim_pending_settlements(INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;

-- ── 5. Extend process_wallet_provider_callback ────────────────
-- After updating transactions.status, if the transaction has a linked
-- settlement_request_id, propagate the terminal status to the settlement
-- request:
--   success → mark_settlement_success (stores provider_ref)
--   failed  → mark_settlement_failed (re-credits merchant ledger)
--
-- Errors from the settlement RPCs are caught so a terminal settlement
-- (e.g. already resolved by a previous callback) does not roll back
-- the transaction status update.
CREATE OR REPLACE FUNCTION public.process_wallet_provider_callback(
  p_provider TEXT,
  p_provider_event_id TEXT,
  p_transaction_id UUID,
  p_new_status TEXT,
  p_provider_transaction_id TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
  v_tx public.transactions%ROWTYPE;
  v_credit NUMERIC := 0;
  v_refund NUMERIC := 0;
  v_merchant_balance NUMERIC := 0;
  v_settlement_updated BOOLEAN := false;
BEGIN
  IF p_provider IS NULL OR p_provider_event_id IS NULL OR p_provider_event_id = '' THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_EVENT';
  END IF;
  IF p_new_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_STATUS';
  END IF;

  INSERT INTO public.provider_webhook_events (
    provider, provider_event_id, transaction_id, payload
  ) VALUES (
    p_provider, p_provider_event_id, p_transaction_id, COALESCE(p_payload, '{}'::jsonb)
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  IF v_tx.status IN ('success', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('processed', false, 'already_terminal', true);
  END IF;

  -- ── Wallet user credits/refunds (existing logic) ──────────────
  IF p_new_status = 'success' AND v_tx.direction = 'collect' AND v_tx.wallet_user_id IS NOT NULL THEN
    v_credit := v_tx.net_amount;
    IF upper(v_tx.currency) = 'CDF' THEN
      UPDATE public.wallet_users
      SET balance_cdf = balance_cdf + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USD' THEN
      UPDATE public.wallet_users
      SET usd_balance = usd_balance + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USDT' THEN
      UPDATE public.wallet_users
      SET usdt_balance = usdt_balance + v_credit, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_WALLET_CURRENCY: %', v_tx.currency;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;
  ELSIF p_new_status = 'failed' AND v_tx.direction = 'payout' AND v_tx.wallet_user_id IS NOT NULL THEN
    v_refund := v_tx.amount + v_tx.fee;
    IF upper(v_tx.currency) = 'CDF' THEN
      UPDATE public.wallet_users
      SET balance_cdf = balance_cdf + v_refund, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSIF upper(v_tx.currency) = 'USD' THEN
      UPDATE public.wallet_users
      SET usd_balance = usd_balance + v_refund, updated_at = now()
      WHERE id = v_tx.wallet_user_id;
    ELSE
      RAISE EXCEPTION 'UNSUPPORTED_WALLET_CURRENCY: %', v_tx.currency;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;
  END IF;

  -- ── Merchant ledger credit (multi-currency) ──────────────────
  IF p_new_status = 'success' AND v_tx.direction = 'collect'
     AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL THEN

    SELECT COALESCE(SUM(
      CASE WHEN type = 'credit' THEN amount ELSE -amount END
    ), 0)
    INTO v_merchant_balance
    FROM public.merchant_ledger_entries
    WHERE merchant_id = v_tx.merchant_id
      AND currency = upper(v_tx.currency);

    v_merchant_balance := v_merchant_balance + v_tx.net_amount;

    INSERT INTO public.merchant_ledger_entries (
      merchant_id, transaction_id, type, amount, balance_after, currency
    ) VALUES (
      v_tx.merchant_id, v_tx.id, 'credit', v_tx.net_amount, v_merchant_balance, upper(v_tx.currency)
    );
  END IF;

  -- ── Update transaction status ────────────────────────────────
  UPDATE public.transactions
  SET status = p_new_status,
      avada_transaction_id = COALESCE(p_provider_transaction_id, avada_transaction_id),
      metadata = COALESCE(p_payload, '{}'::jsonb),
      updated_at = now()
  WHERE id = v_tx.id;

  -- ── Settlement propagation (NEW) ──────────────────────────────
  -- If this transaction is linked to a settlement request, propagate
  -- the terminal status. mark_settlement_failed re-credits the
  -- merchant ledger (the settlement was debited at creation time).
  -- mark_settlement_success stores the provider_ref and marks the
  -- settlement as complete.
  IF v_tx.settlement_request_id IS NOT NULL THEN
    IF p_new_status = 'success' THEN
      BEGIN
        PERFORM public.mark_settlement_success(
          v_tx.settlement_request_id,
          COALESCE(p_provider_transaction_id, v_tx.avada_transaction_id)
        );
        v_settlement_updated := true;
      EXCEPTION WHEN OTHERS THEN
        -- Settlement may already be terminal (e.g. reconciled by a
        -- previous tick, or manually resolved). Do not roll back the
        -- transaction status update.
        RAISE NOTICE 'Settlement % mark_success skipped: %',
          v_tx.settlement_request_id, SQLERRM;
      END;
    ELSIF p_new_status = 'failed' THEN
      BEGIN
        PERFORM public.mark_settlement_failed(
          v_tx.settlement_request_id,
          'Provider callback: payout failed'
        );
        v_settlement_updated := true;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Settlement % mark_failed skipped: %',
          v_tx.settlement_request_id, SQLERRM;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credited', v_credit,
    'refunded', v_refund,
    'status', p_new_status,
    'merchant_ledger_credited',
      (p_new_status = 'success' AND v_tx.direction = 'collect'
       AND v_tx.wallet_user_id IS NULL AND v_tx.merchant_id IS NOT NULL),
    'merchant_ledger_currency', upper(v_tx.currency),
    'settlement_updated', v_settlement_updated
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_wallet_provider_callback(TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
