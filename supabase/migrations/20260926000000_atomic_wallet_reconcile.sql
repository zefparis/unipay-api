-- ============================================================
-- M4 remediation: atomic wallet reconciliation (anti double-credit)
-- ============================================================
-- Closes the TOCTOU race in admin/wallet-reconcile.ts where the
-- transaction status was checked in a SELECT, then the wallet
-- balance credited in a separate UPDATE. Two concurrent
-- reconciliation calls (double-click, network retry, two admins)
-- could both pass the status check before either credit was
-- visible, causing a double-credit.
--
-- This RPC does everything atomically in a single transaction:
--   1. Lock the transaction row (FOR UPDATE)
--   2. If status is already terminal (success/failed), return
--      idempotent no-op (already_terminal = true) — no double-credit
--   3. Update transaction status to the target status
--   4. Credit (deposit success) or refund (withdrawal failed) the
--      wallet balance
--   5. Return the new balance + action taken
--
-- Idempotence: if a second call arrives after the first has
-- committed, the transaction is already terminal → the second
-- call returns already_terminal = true and does NOT credit again.

CREATE OR REPLACE FUNCTION public.wallet_reconcile_atomic(
  p_tx_id        UUID,
  p_target_status TEXT,
  p_delta        NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx          public.transactions%ROWTYPE;
  v_new_balance NUMERIC;
  v_action      TEXT := 'none';
  v_already     BOOLEAN := false;
BEGIN
  IF p_target_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'INVALID_TARGET_STATUS: %', p_target_status;
  END IF;

  -- Lock the transaction row
  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_tx_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND';
  END IF;

  -- Idempotence: if already terminal, no-op (no double-credit)
  IF v_tx.status = 'success' OR v_tx.status = 'failed' THEN
    v_already := true;
    RETURN jsonb_build_object(
      'already_terminal', true,
      'previous_status', v_tx.status,
      'action', 'none',
      'delta', 0
    );
  END IF;

  -- Update transaction status
  UPDATE public.transactions
  SET status = p_target_status
  WHERE id = p_tx_id;

  -- Credit/refund wallet if delta > 0
  IF p_delta > 0 AND v_tx.wallet_user_id IS NOT NULL THEN
    UPDATE public.wallet_users
    SET balance_cdf = balance_cdf + p_delta,
        updated_at = now()
    WHERE id = v_tx.wallet_user_id
    RETURNING balance_cdf INTO v_new_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    IF p_target_status = 'success' THEN
      v_action := 'credited';
    ELSE
      v_action := 'refunded';
    END IF;
  ELSE
    v_new_balance := null;
  END IF;

  RETURN jsonb_build_object(
    'already_terminal', false,
    'previous_status', v_tx.status,
    'new_status', p_target_status,
    'action', v_action,
    'delta', p_delta,
    'new_balance', v_new_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wallet_reconcile_atomic(UUID, TEXT, NUMERIC) TO service_role;
